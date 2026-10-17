package com.birdreport.hot;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;

/**
 * 「稀有监听」在 Android 端的后台部分：定时问一次本机服务端的 /api/watch/check，
 * 有新发现、且应用不在前台时就发一条系统通知；点通知回到应用直接打开历史记录。
 *
 * <h3>为什么只在「不在前台」时轮询</h3>
 * 网页端自己也在前台轮询同一支接口，而服务端是**消费式**的：每一轮真正回源发现的
 * 新鸟种会被写进 alerted 表，谁先问到就归谁。两边同时轮询的话，后台这一侧很可能把
 * 新发现「抢」走 —— 前台反而看不到右下角那张提示卡。所以前台交给网页、后台交给这里
 * （由 MainActivity 的 onStart / onStop 切换），两边互不打架。
 *
 * <h3>不用 WorkManager / 前台服务的原因</h3>
 * 本项目的服务端（Node）就跑在**同一个进程**里，进程没了接口也就没了：用 WorkManager
 * 到点唤醒进程去问一个已经死掉的本地端口，只会得到连接失败。前台服务倒是能常驻，但要
 * 一直挂一条「正在运行」的通知，跟「安静地盯鸟」这个诉求相反。所以这里用进程内的
 * HandlerThread 定时器，代价说清楚：从最近任务里划掉应用（或系统回收进程）之后就不再
 * 提醒了 —— 这是「本地服务端 + WebView」这套架构的固有边界。
 *
 * <h3>多问几次没关系</h3>
 * 服务端有一道**最短回源间隔**（默认 30 分钟）：没到点的轮次直接复用上一轮结果、不会
 * 真的打上游。所以这里按客户端节奏问，不会把记录中心问烦。
 */
public class WatchNotifier {

    private static final String TAG = "BirdWatch";
    private static final String CHANNEL_ID = "birdreport.watch";
    /** 固定 id：后一条提醒覆盖前一条，不在通知栏里堆一列 */
    private static final int NOTIFY_ID = 0x57415448;

    private static final long MIN_INTERVAL_MS = 10 * 60 * 1000L;
    private static final long MAX_INTERVAL_MS = 60 * 60 * 1000L;
    /** 退到后台后第一次检查的延迟：给网页端一个「它先停、我后动」的空档 */
    private static final long BACKGROUND_FIRST_DELAY_MS = 60 * 1000L;

    private final Context app;
    private final String baseUrl;

    private HandlerThread thread;
    private Handler handler;

    private volatile boolean enabled = false;
    private volatile boolean foreground = true;
    private volatile long intervalMs = MIN_INTERVAL_MS;

    /** 已发现但还没让页面看过的条数：回到前台时交给页面补个角标 */
    private int pendingCount = 0;

    public WatchNotifier(Context context, String baseUrl) {
        this.app = context.getApplicationContext();
        this.baseUrl = baseUrl;
    }

    /* ---------------------------------------------------------------- *
     * 通知渠道与权限
     * ---------------------------------------------------------------- */

    /** 建渠道（API 26+ 必须；重复调用是安全的，系统会忽略已存在的同名渠道） */
    public static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) {
            return;
        }
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        if (nm.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                ctx.getString(R.string.watch_channel_name),
                NotificationManager.IMPORTANCE_HIGH); // HIGH：锁屏上能弹出来，不然「提醒」没意义
        ch.setDescription(ctx.getString(R.string.watch_channel_desc));
        ch.enableVibration(true);
        nm.createNotificationChannel(ch);
    }

    /** "granted" / "missing" —— 给网页端决定要不要弹权限申请用 */
    public static String permissionState(Context ctx) {
        if (Build.VERSION.SDK_INT < 33) {
            return "granted"; // 33 以前通知权限是安装即得，只在系统设置里关
        }
        boolean ok = ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        return ok ? "granted" : "missing";
    }

    public static boolean canNotify(Context ctx) {
        boolean on = true;
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            on = nm != null && nm.areNotificationsEnabled();
        } catch (Throwable ignored) {
            // 个别 ROM 上没有这个方法，按「能发」处理，让 NotificationManager 自己丢
        }
        return on && "granted".equals(permissionState(ctx));
    }

    /* ---------------------------------------------------------------- *
     * 开关与前台状态
     * ---------------------------------------------------------------- */

    /**
     * 由网页端通过 JS 桥调用（开启 / 停止监听、以及页面每次恢复状态时）。
     *
     * @param on        监听是否开着；false 时停掉定时器
     * @param intervalMs 服务端给的轮询间隔，会被夹到 [10 分钟, 1 小时]
     */
    public void sync(final boolean on, long intervalMs) {
        this.intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, intervalMs));
        this.enabled = on;
        Log.i(TAG, "后台轮询 " + (on ? "开启，间隔 " + (this.intervalMs / 60000) + " 分钟" : "关闭"));
        if (on) {
            ensureThread();
            handler.removeCallbacks(tick);
            // 刚开启时先等一个间隔：此刻用户多半刚在页面上开过监听，那一轮刚回源过
            handler.postDelayed(tick, this.intervalMs);
        } else if (handler != null) {
            handler.removeCallbacks(tick);
        }
    }

    /** MainActivity 的 onStart / onStop 调这个 */
    public void setForeground(boolean fg) {
        boolean was = this.foreground;
        this.foreground = fg;
        if (was || fg || !enabled || handler == null) {
            return;
        }
        // 刚刚退到后台：不等满一个间隔，先安排一次
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, BACKGROUND_FIRST_DELAY_MS);
    }

    /** 取走「已发现但页面还没看过」的条数（回前台时用），顺带清零 */
    public int takePending() {
        int n = pendingCount;
        pendingCount = 0;
        return n;
    }

    private void ensureThread() {
        if (thread == null) {
            thread = new HandlerThread("bird-watch-poll");
            thread.start();
            handler = new Handler(thread.getLooper());
        }
    }

    /* ---------------------------------------------------------------- *
     * 轮询
     * ---------------------------------------------------------------- */

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!enabled) {
                return;
            }
            // 前台不发：网页端自己在轮询同一支接口，见类注释里的「消费式」说明
            if (!foreground) {
                try {
                    poll();
                } catch (Throwable t) {
                    Log.w(TAG, "后台检查失败：" + t); // 网络抖动很正常，不打扰用户，下一轮再来
                }
            }
            if (enabled) {
                handler.postDelayed(this, intervalMs);
            }
        }
    };

    private void poll() throws Exception {
        String body = httpGet(baseUrl + "api/watch/check");
        if (body == null) {
            return;
        }
        JSONObject json = new JSONObject(body);
        if (!json.optBoolean("enabled", false)) {
            // 用户在别处（网页 / 另一台设备）把监听关了：本机也跟着停
            enabled = false;
            Log.i(TAG, "服务端报告监听已关闭，停止后台轮询");
            return;
        }
        JSONArray alerts = json.optJSONArray("newAlerts");
        int n = alerts == null ? 0 : alerts.length();
        if (n == 0) {
            return;
        }
        pendingCount += n;
        Log.i(TAG, "后台发现 " + n + " 种稀有鸟种");
        if (canNotify(app)) {
            post(alerts);
        } else {
            Log.w(TAG, "没有通知权限，改为回到前台时在页面上提示");
        }
    }

    private String httpGet(String url) throws Exception {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(3000);
            // 服务端这一轮可能真的要回源（一次上游请求 + 近两年历史），给足时间
            c.setReadTimeout(90000);
            c.setRequestProperty("Accept", "application/json");
            if (c.getResponseCode() != 200) {
                return null;
            }
            InputStream in = c.getInputStream();
            BufferedReader r = new BufferedReader(new InputStreamReader(in, Charset.forName("UTF-8")));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line);
            }
            r.close();
            return sb.toString();
        } finally {
            if (c != null) {
                c.disconnect();
            }
        }
    }

    /* ---------------------------------------------------------------- *
     * 发通知
     * ---------------------------------------------------------------- */

    /**
     * 手动发一条测试通知（网页端「我的 → 稀有监听 → 测试发送」，仅作者可见）。
     *
     * <p>目的：把「通知发不出来」和「轮询没跑 / 这一轮没发现新鸟种」这两种完全不同的故障分开。
     * 它走的是同一套 NotificationManager 调用、同一个通知渠道，但完全不依赖轮询有没有跑起来，
     * 所以点一下就知道通知链路本身通不通。
     *
     * @return {@code "sent"} 已发出 / {@code "missing"} Android 13+ 的运行时权限没给 /
     *         {@code "blocked"} 用户在系统设置里把本应用的通知关了 /
     *         {@code "error:…"} 其它失败
     */
    public String postTest() {
        ensureChannel(app);
        if (!"granted".equals(permissionState(app))) {
            return "missing";
        }
        if (!canNotify(app)) {
            return "blocked"; // areNotificationsEnabled() == false
        }
        boolean ok = post(
                "啾讯 · 测试通知",
                "通知链路正常",
                "点这条通知会回到应用并打开「监听历史记录」。\n" +
                        "真正发现稀有鸟种时，这里会列出鸟种名与本时段 / 近两年的条数。");
        return ok ? "sent" : "error:NotificationManager 抛异常（见 logcat -s BirdWatch）";
    }

    private void post(JSONArray alerts) {
        int n = alerts.length();
        StringBuilder names = new StringBuilder();
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < n; i++) {
            JSONObject a = alerts.optJSONObject(i);
            if (a == null) {
                continue;
            }
            String name = a.optString("name", "");
            if (name.isEmpty()) {
                continue;
            }
            if (names.length() > 0) {
                names.append("、");
            }
            names.append(name);
            if (big.length() > 0) {
                big.append('\n');
            }
            // 一行一种：本时段条数 + 近两年条数（判定依据），和页面上的口径一致
            big.append("· ").append(name)
                    .append("　本时段 ").append(a.optInt("count", 0)).append(" 条")
                    .append(" · 近两年 ").append(a.optInt("historyCount", 0)).append(" 条");
        }
        if (names.length() == 0) {
            return;
        }
        String title = "发现 " + n + " 种稀有鸟种";
        // 折叠态：最多列两种，多了用「等」
        String brief = names.length() <= 24 ? names.toString() : names.substring(0, 24) + "…";
        post(title, brief, big.toString());
    }

    /** 真正把通知交给系统。@return 是否发出去了（false = 抛异常，已写 logcat） */
    private boolean post(String title, String brief, String big) {
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return false;
        }

        Intent open = new Intent(app, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra(MainActivity.EXTRA_OPEN_WATCH, true);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getActivity(app, 1, open, piFlags);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(app, CHANNEL_ID);
        } else {
            b = new Notification.Builder(app);
            b.setPriority(Notification.PRIORITY_HIGH);
        }
        b.setSmallIcon(R.drawable.ic_stat_watch)
                .setContentTitle(title)
                .setContentText(brief)
                .setStyle(new Notification.BigTextStyle().bigText(big.toString()))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setOnlyAlertOnce(false);
        if (Build.VERSION.SDK_INT >= 21 && Build.VERSION.SDK_INT < 33) {
            b.setVisibility(Notification.VISIBILITY_PUBLIC); // 锁屏上直接可见
        }
        try {
            nm.notify(NOTIFY_ID, b.build());
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "发通知失败：" + t);
            return false;
        }
    }
}
