package com.birdreport.hot;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
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
 * 网页、接口、缓存全都在 Node 那边，这边只是个壳（外加一层很薄的 JS 桥，
 * 只为了通知权限与后台轮询，见 AndroidBridge / WatchNotifier）。
 */
public class MainActivity extends Activity {

    private static final String TAG = "BirdNode";
    private static final int PORT = 8787;
    private static final String HOME = "http://127.0.0.1:" + PORT + "/";
    private static final long MAX_WAIT_MS = 60_000L;

    /** 点通知进来时要直接打开「监听历史记录」 */
    public static final String EXTRA_OPEN_WATCH = "openWatch";

    private WebView web;
    private LinearLayout splash;
    private TextView splashText;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean pageLoaded = false;

    private WatchNotifier notifier;
    /** 页面已加载完、就等它打开监听记录（点通知进来的情况） */
    private boolean openWatchPending = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WatchNotifier.ensureChannel(this);
        notifier = new WatchNotifier(this, HOME);
        buildUi();
        // 网页要用的桥：只暴露通知权限与后台轮询（页面里用 window.BirdAndroid 判断）
        web.addJavascriptInterface(new AndroidBridge(this, notifier), "BirdAndroid");
        if (getIntent() != null && getIntent().getBooleanExtra(EXTRA_OPEN_WATCH, false)) {
            openWatchPending = true;
        }
        startNode();
        waitForServer();
    }

    /** 点通知后应用可能已经在运行：singleTask + SINGLE_TOP 会把 Intent 送到这里 */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getBooleanExtra(EXTRA_OPEN_WATCH, false)) {
            openWatchPending = true;
            openWatchIfReady();
        }
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
        s.setSupportMultipleWindows(true); // 配合下面的 onCreateWindow：target=_blank 的链接去系统浏览器
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        // 页面里 target=_blank 的链接（记录中心原页、505 时的「输入验证码」页……）用**系统浏览器**
        // 打开：WebView 默认不新开窗口，不接管的话这些链接在 APK 里点了没反应。
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
                WebView tmp = new WebView(MainActivity.this);
                tmp.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                        } catch (Exception ignored) {
                            // 设备上没有可用浏览器：静默失败，别把 App 带崩
                        }
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(tmp);
                resultMsg.sendToTarget();
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                splash.setVisibility(View.GONE);
                openWatchIfReady();
                flushPendingAlerts();
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

    /* ---------------------------------------------------------------- *
     * 通知：权限申请 / 点通知进页面 / 把后台发现过的条数交给页面
     * ---------------------------------------------------------------- */

    /** 网页端通过 JS 桥调（targetSdk 33 起 POST_NOTIFICATIONS 必须运行时申请） */
    public void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) {
            return;
        }
        if ("granted".equals(WatchNotifier.permissionState(this))) {
            return;
        }
        try {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, AndroidBridge.REQ_NOTIFY);
        } catch (Throwable t) {
            Log.w(TAG, "申请通知权限失败：" + t);
        }
    }

    private void openWatchIfReady() {
        if (!pageLoaded || !openWatchPending || web == null) {
            return;
        }
        openWatchPending = false;
        web.evaluateJavascript("window.__birdOpenWatch && window.__birdOpenWatch();", null);
    }

    /**
     * 把下载好的新版 APK 交给系统安装器（网页端点「下载并更新」后由 JS 桥调过来）。
     *
     * 传的是**内容 URI**（{@link ApkFileProvider}）而不是文件路径：Android 7 起把 file://
     * 交给别的应用会直接抛 FileUriExposedException。路径必须是应用私有目录里的（provider 那边
     * 还会再校验一遍越界），并带上 FLAG_GRANT_READ_URI_PERMISSION 让安装器能读。
     *
     * Android 8+ 还需要用户允许「安装未知应用」—— 没允许时系统会自己弹对话框并给一个
     * 去设置的入口，所以这里不做拦截，交给系统。
     */
    public void installApk(String absPath) {
        try {
            File base = getFilesDir();
            File f = new File(absPath == null ? "" : absPath);
            if (!f.isFile()) {
                Log.w(TAG, "安装包不存在：" + absPath);
                return;
            }
            String root = base.getCanonicalPath();
            String target = f.getCanonicalPath();
            if (!target.startsWith(root + File.separator)) {
                Log.w(TAG, "安装包不在应用私有目录里，拒绝安装：" + target);
                return;
            }
            // 与 ApkFileProvider 的 URI 规则对应：authority + 相对 filesDir 的路径
            String rel = target.substring(root.length()); // 以 / 开头
            Intent it = new Intent(Intent.ACTION_VIEW);
            it.setDataAndType(Uri.parse("content://" + ApkFileProvider.AUTHORITY + rel),
                    "application/vnd.android.package-archive");
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            Log.i(TAG, "调起安装器：" + target);
            startActivity(it);
        } catch (Throwable t) {
            Log.e(TAG, "调起安装器失败", t);
        }
    }

    /**
     * 后台轮询发现过、但页面当时不在前台的条数：回到前台交给页面补个角标。
     * ⚠ 那几条在服务端已经被记进「已提醒」表了，页面的下一次 check 不会再报一次 ——
     *   所以这里必须把条数补给它，否则用户回到应用会以为「什么都没发生」。
     */
    private void flushPendingAlerts() {
        if (notifier == null || !pageLoaded || web == null) {
            return;
        }
        int n = notifier.takePending();
        if (n <= 0) {
            return;
        }
        web.evaluateJavascript("window.__birdWatchNotifyPending && window.__birdWatchNotifyPending(" + n + ");", null);
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

    /**
     * 前台的判定交给这里：网页端在页面前台时自己轮询 /api/watch/check，退到后台就停；
     * 后台那一份由 WatchNotifier 接手 —— 两边都开着会互相「抢」新发现（接口是消费式的，
     * 谁先问到就归谁），所以必须一前一后。详见 WatchNotifier 的类注释。
     */
    @Override
    protected void onStart() {
        super.onStart();
        if (notifier != null) {
            notifier.setForeground(true);
        }
        // 后台期间发现过的条数，这时补给页面（它自己的 check 已经拿不到了）
        flushPendingAlerts();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (notifier != null) {
            notifier.setForeground(false);
        }
    }

    /**
     * 返回（手势侧滑 / 返回键）先在页面里走一层：弹层（「我的」/ 明细 / 报告详情 /
     * TODO 列表）开着就关掉它；页面返回 false 才轮到 WebView 历史，最后才退出 App。
     */
    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(window.__birdHandleBack && window.__birdHandleBack()) ? '1' : '0'",
                value -> {
                    // ⚠ evaluateJavascript 回传的是结果的 **JSON 表示**：JS 返回字符串 '1'，
                    // 这里拿到的 Java 字符串是带引号的 "\"1\""（三个字符），所以 equals("1")
                    // 永远不成立 —— 页面明明已经关掉弹层并返回了 true，却被判成「没消费」，
                    // 紧接着又走 defaultBack()：弹层关掉的同一时刻 App 一路退到桌面。
                    // 必须先剥掉引号再比。
                    String v = value == null ? "" : value.replace("\"", "").trim();
                    if ("1".equals(v)) {
                        return; // 页面自己消费了这次返回（关掉了弹层）
                    }
                    defaultBack();
                });
    }

    /** 页面没东西可关时的默认返回：先退 WebView 历史，再退出 App */
    private void defaultBack() {
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
