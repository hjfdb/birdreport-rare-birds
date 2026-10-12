package com.birdreport.hot;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 把 assets/nodejs-project/** 解包到应用私有目录。
 *
 * 为什么要解包：Node 只认真实文件路径 —— fs.readFileSync、动态 import、ESM 模块解析
 * 全都走文件系统，而 assets 里的内容只能通过 AssetManager 读，没有路径。
 *
 * 版本标记：只有 APK 版本变了才重新解包，避免每次启动都做无谓的 IO。
 * 缓存目录用的是 filesDir/data（在 nodejs-project 之外），所以重新解包不会把缓存删掉。
 */
final class AssetInstaller {

    private static final String TAG = "BirdNode";
    private static final String SRC_ASSET_DIR = "nodejs-project";
    private static final String MARKER = ".assets-version";

    private AssetInstaller() {
    }

    /** 确保私有目录里有一份和当前 APK 版本匹配的 nodejs-project，返回它的根目录 */
    static File ensure(Context ctx) throws IOException {
        File root = new File(ctx.getFilesDir(), SRC_ASSET_DIR);
        File marker = new File(root, MARKER);
        String wanted = stamp(ctx);

        if (marker.isFile() && wanted.equals(readText(marker))) {
            return root;
        }

        Log.i(TAG, "解包 nodejs-project（版本标记 " + wanted + "）");
        deleteRecursively(root);
        copyAssetDir(ctx, SRC_ASSET_DIR, root);
        writeText(marker, wanted);
        return root;
    }

    private static String stamp(Context ctx) {
        try {
            PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return info.versionCode + ":" + info.versionName;
        } catch (Exception e) {
            return "unknown";
        }
    }

    private static void copyAssetDir(Context ctx, String assetPath, File dest) throws IOException {
        String[] children = ctx.getAssets().list(assetPath);

        if (children != null && children.length > 0) {
            if (!dest.exists() && !dest.mkdirs()) {
                throw new IOException("无法创建目录 " + dest);
            }
            for (String child : children) {
                copyAssetDir(ctx, assetPath + "/" + child, new File(dest, child));
            }
            return;
        }

        // 没有子项 —— 当成普通文件复制
        try (InputStream in = ctx.getAssets().open(assetPath);
             OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        }
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) {
            return;
        }
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static String readText(File f) {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[(int) f.length()];
            int n = in.read(buf);
            return n > 0 ? new String(buf, 0, n, "UTF-8") : "";
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeText(File f, String text) {
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(text.getBytes("UTF-8"));
        } catch (IOException e) {
            Log.w(TAG, "写入版本标记失败：" + e.getMessage());
        }
    }
}
