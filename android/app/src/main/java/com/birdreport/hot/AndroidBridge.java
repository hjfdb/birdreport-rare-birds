package com.birdreport.hot;

import android.webkit.JavascriptInterface;

/**
 * 给网页端用的一层**很薄**的桥（注册名 {@code window.BirdAndroid}）。
 *
 * 只有三件事必须由原生侧做，其余全在网页那边：
 *   · 通知权限（targetSdk 33 起 POST_NOTIFICATIONS 是运行时权限，网页要不了）；
 *   · 把「监听开着没」同步给后台轮询线程（见 {@link WatchNotifier} 的类注释）；
 *   · 应用内更新：把下好的 APK 交给系统安装器（见 {@link #installApk}）。
 *
 * 网页端每次都先用 {@code window.BirdAndroid && BirdAndroid.isAndroid()} 判断，
 * 所以在浏览器直接打开页面（Bridge 不存在）时这些调用会被安全跳过。
 *
 * ⚠ 桥方法跑在 WebView 的 JavaBridge 线程上，**不是**主线程：任何碰界面的调用
 * （比如 requestPermissions、startActivity）都必须自己 post 回主线程。
 */
public class AndroidBridge {

    /** requestPermissions 的回调码，随便取一个本 Activity 内唯一的值 */
    static final int REQ_NOTIFY = 9001;

    private final MainActivity activity;
    private final WatchNotifier notifier;

    AndroidBridge(MainActivity activity, WatchNotifier notifier) {
        this.activity = activity;
        this.notifier = notifier;
    }

    /** 有桥就是 Android 壳 —— 页面靠它决定要不要显示「后台通知」相关的提示 */
    @JavascriptInterface
    public boolean isAndroid() {
        return true;
    }

    /** "granted" / "missing" */
    @JavascriptInterface
    public String notifyState() {
        return WatchNotifier.permissionState(activity);
    }

    /** 申请通知权限（只在需要时真的弹系统对话框；已授权就什么也不做） */
    @JavascriptInterface
    public void requestNotify() {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.requestNotificationPermission();
            }
        });
    }

    /**
     * 把「监听是否开着」以及轮询间隔同步给后台。
     * 网页在开启 / 停止监听、以及每次恢复状态时调用。
     */
    @JavascriptInterface
    public void syncWatch(boolean enabled, int intervalMs) {
        notifier.sync(enabled, intervalMs);
    }

    /**
     * 应用内更新：把服务端下好的 APK 交给系统安装器。
     *
     * @param path 服务端给的**绝对路径**（应用私有目录里的，形如
     *             {@code /data/user/0/com.birdreport.hot/files/data/download/v0.0.17/xxx.apk}）。
     *             页面从 /api/version 的 {@code download.path} 拿。
     */
    @JavascriptInterface
    public void installApk(final String path) {
        // startActivity 必须在主线程（桥方法跑在 JavaBridge 线程上）
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.installApk(path);
            }
        });
    }
}
