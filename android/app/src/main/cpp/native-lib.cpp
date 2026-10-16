/*
 * JNI 桥：把 nodejs-mobile 的 node::Start() 暴露给 Java。
 *
 * nodejs-mobile 只提供一个 libnode.so，入口是 C++ 的 node::Start(argc, argv)，
 * 没有现成的 Java 封装，所以这几行胶水必须自己编（AGP 会用 NDK + CMake 编）。
 */
#include <jni.h>

#include <android/log.h>
#include <pthread.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "node.h"

#define LOG_TAG "BirdNode"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

int gStdoutPipe[2] = {-1, -1};

void* pumpToLogcat(void* /*arg*/) {
    char buf[1024];
    std::string pending;
    ssize_t n;
    while ((n = read(gStdoutPipe[0], buf, sizeof(buf) - 1)) > 0) {
        buf[n] = '\0';
        pending += buf;
        size_t pos;
        while ((pos = pending.find('\n')) != std::string::npos) {
            LOGI("%s", pending.substr(0, pos).c_str());
            pending.erase(0, pos + 1);
        }
    }
    if (!pending.empty()) {
        LOGI("%s", pending.c_str());
    }
    return nullptr;
}

/**
 * 把 Node 的 stdout / stderr 接到 logcat。
 * 手机上没法像桌面那样直接看控制台，服务端的启动日志、报错全在 logcat 里：
 *   adb logcat -s BirdNode
 */
void redirectStdioToLogcat() {
    if (pipe(gStdoutPipe) != 0) {
        LOGE("pipe() 失败，Node 的输出将看不到");
        return;
    }
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    dup2(gStdoutPipe[1], STDOUT_FILENO);
    dup2(gStdoutPipe[1], STDERR_FILENO);

    pthread_t tid;
    if (pthread_create(&tid, nullptr, pumpToLogcat, nullptr) == 0) {
        pthread_detach(tid);
    } else {
        LOGE("日志线程创建失败");
    }
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_com_birdreport_hot_NodeRunner_startNode(JNIEnv* env, jclass /*clazz*/,
                                             jobjectArray jArgs, jstring jDataDir) {
    redirectStdioToLogcat();

    const char* dataDir = env->GetStringUTFChars(jDataDir, nullptr);
    if (dataDir != nullptr) {
        // Android 上进程没有「当前目录」这个概念（cwd 是 /），
        // 缓存往哪写必须显式告诉 Node，否则 mkdir 会直接失败。
        setenv("BIRD_DATA_DIR", dataDir, 1);
        setenv("TMPDIR", dataDir, 1);
        setenv("HOME", dataDir, 1);
        LOGI("数据目录 BIRD_DATA_DIR=%s", dataDir);
        env->ReleaseStringUTFChars(jDataDir, dataDir);
    }
    setenv("HOST", "127.0.0.1", 1);
    // 让 Node 侧明确知道自己在 Android 上（server/version.mjs 用它选发布产物：
    // process.platform 在 nodejs-mobile 里不一定可靠，所以这里显式给一个）。
    setenv("BIRD_PLATFORM", "android-arm64", 1);

    const jsize argc = env->GetArrayLength(jArgs);
    std::vector<std::string> store;
    store.reserve(static_cast<size_t>(argc));
    for (jsize i = 0; i < argc; ++i) {
        jstring s = static_cast<jstring>(env->GetObjectArrayElement(jArgs, i));
        const char* c = env->GetStringUTFChars(s, nullptr);
        store.emplace_back(c == nullptr ? "" : c);
        if (c != nullptr) {
            env->ReleaseStringUTFChars(s, c);
        }
        env->DeleteLocalRef(s);
    }

    std::vector<char*> argv;
    argv.reserve(static_cast<size_t>(argc) + 1);
    for (auto& s : store) {
        argv.push_back(const_cast<char*>(s.c_str()));
    }
    argv.push_back(nullptr);

    LOGI("调用 node::Start，参数 %d 个", static_cast<int>(argc));
    const int rc = node::Start(static_cast<int>(argc), argv.data());
    LOGI("node::Start 返回 %d", rc);
    return rc;
}
