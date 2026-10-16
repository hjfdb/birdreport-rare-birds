package com.birdreport.hot;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简的文件 ContentProvider —— 唯一用途：把**下载好的新版 APK**交给系统安装器。
 *
 * 为什么自己写、不用 {@code androidx.core.content.FileProvider}：
 * 这个项目刻意不依赖 AndroidX（{@code android.useAndroidX=false}，界面只用系统自带控件），
 * 为了一个 FileProvider 把整条 AndroidX 链拉进来不划算。需要的能力就两条：
 *   · 把 {@code getFilesDir()} 下的某个文件以只读方式 open 出去；
 *   · 配合 {@code android:grantUriPermissions="true"}，让接收方临时拿到读权限
 *     （Android 7 起直接传 file:// 会抛 FileUriExposedException，必须走内容 URI）。
 *
 * URI 形态：{@code content://com.birdreport.hot.files/<相对 filesDir 的路径>}
 *   例：filesDir/data/download/v0.0.17/xxx.apk
 *       → content://com.birdreport.hot.files/data/download/v0.0.17/xxx.apk
 * 这个映射关系与 MainActivity.installApk() 里算出来的路径必须一致。
 */
public class ApkFileProvider extends ContentProvider {

    /** 必须与 AndroidManifest.xml 里 provider 的 android:authorities 一致 */
    public static final String AUTHORITY = "com.birdreport.hot.files";

    /** 安装器认这个 MIME；给错了有些 ROM 会直接拒绝打开 */
    private static final String APK_MIME = "application/vnd.android.package-archive";

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File base = getContext().getFilesDir();
        String rel = uri.getPath();
        File f = new File(base, rel == null ? "" : rel.replaceFirst("^/+", ""));

        // 目录穿越防护：解析出来的真实路径必须落在 filesDir 里面（..%2f 之类都得挡住）。
        // ⚠ 用 getCanonicalPath 而不是 getAbsolutePath —— 后者不解析 ".."。
        try {
            String root = base.getCanonicalPath() + File.separator;
            if (!f.getCanonicalPath().startsWith(root)) {
                throw new FileNotFoundException("越界：" + uri);
            }
        } catch (java.io.IOException e) {
            throw new FileNotFoundException("路径解析失败：" + uri);
        }

        if (!f.isFile()) {
            throw new FileNotFoundException(String.valueOf(uri));
        }
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return APK_MIME;
    }

    /* 只读共享，其余四个方法都用不上 */

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
