package com.birdreport.hot;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 应用的唯一界面。
 *
 * 结构很简单：先在后台线程里把 Node 服务端跑起来（内容就是网页端那套 server/*.mjs），
 * 等服务端在本机 8787 端口能应答了，再用 WebView 打开 http://127.0.0.1:8787/。
 * 网页、接口、缓存全都在 Node 那边，这边只是个壳。
 */
public class MainActivity extends Activity {

    private static final String TAG = "BirdNode";
    private static final int PORT = 8787;
    private static final String HOME = "http://127.0.0.1:" + PORT + "/";
    private static final long MAX_WAIT_MS = 60_000L;

    private WebView web;
    private LinearLayout splash;
    private TextView splashText;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean pageLoaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        startNode();
        waitForServer();
    }

    /* ---------------------------------------------------------------- *
     * 界面
     * ---------------------------------------------------------------- */

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // 页面用 localStorage 记住上次选的省市与时间
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE); // 服务端已声明 no-store
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                splash.setVisibility(View.GONE);
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        splash = new LinearLayout(this);
        splash.setOrientation(LinearLayout.VERTICAL);
        splash.setGravity(Gravity.CENTER);
        splash.setBackgroundColor(Color.WHITE);
        splash.addView(new ProgressBar(this));

        splashText = new TextView(this);
        splashText.setText("正在启动本地服务…");
        splashText.setTextColor(Color.parseColor("#444441"));
        splashText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        splashText.setGravity(Gravity.CENTER);
        splashText.setPadding(48, 32, 48, 0);
        splash.addView(splashText);

        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    private void showMessage(final String msg) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (!pageLoaded) {
                    splash.setVisibility(View.VISIBLE);
                    splashText.setText(msg);
                }
            }
        });
    }

    /* ---------------------------------------------------------------- *
     * 启动 Node 服务端
     * ---------------------------------------------------------------- */

    private void startNode() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File project = AssetInstaller.ensure(MainActivity.this);
                    File entry = new File(project, "server/index.mjs");
                    File data = new File(getFilesDir(), "data");
                    if (!data.exists() && !data.mkdirs()) {
                        Log.w(TAG, "数据目录创建失败：" + data);
                    }

                    Log.i(TAG, "启动 Node：" + entry.getAbsolutePath());
                    int code = NodeRunner.startNode(
                            new String[]{"node", entry.getAbsolutePath()},
                            data.getAbsolutePath());
                    Log.w(TAG, "Node 已退出，返回码 " + code);
                    showMessage("本地服务已退出（返回码 " + code + "）。\n日志见 adb logcat -s BirdNode");
                } catch (Throwable t) {
                    Log.e(TAG, "Node 启动失败", t);
                    showMessage("启动失败：" + t);
                }
            }
        }, "node-runtime").start();
    }

    /** 轮询 /api/health，通了就把页面载进 WebView */
    private void waitForServer() {
        final long startedAt = System.currentTimeMillis();
        new Thread(new Runnable() {
            @Override
            public void run() {
                while (!pageLoaded) {
                    if (ping(HOME + "api/health")) {
                        ui.post(new Runnable() {
                            @Override
                            public void run() {
                                if (!pageLoaded) {
                                    splashText.setText("服务已就绪，正在加载页面…");
                                    web.loadUrl(HOME);
                                }
                            }
                        });
                        return;
                    }
                    if (System.currentTimeMillis() - startedAt > MAX_WAIT_MS) {
                        showMessage("本地服务启动超时。\n请确认手机能联网，然后重新打开应用。");
                        return;
                    }
                    try {
                        Thread.sleep(400);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }
        }, "wait-server").start();
    }

    private static boolean ping(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(1000);
            c.setReadTimeout(1500);
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) {
                c.disconnect();
            }
        }
    }

    /* ---------------------------------------------------------------- *
     * 生命周期
     * ---------------------------------------------------------------- */

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        // Node 的事件循环没法优雅停掉（node::Start 一直阻塞着），
        // 所以退出时直接结束进程 —— 否则下次打开时 8787 还被上次占着。
        android.os.Process.killProcess(android.os.Process.myPid());
    }
}
