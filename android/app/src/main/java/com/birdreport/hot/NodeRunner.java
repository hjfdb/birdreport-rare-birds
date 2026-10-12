package com.birdreport.hot;

/**
 * libnode.so 的入口封装。
 *
 * APK 里有两个原生库：
 *   libnode.so     —— nodejs-mobile 提供的 Node 运行时（预编译，直接放进 jniLibs）
 *   libbirdnode.so —— 本项目自己的 JNI 桥（见 cpp/native-lib.cpp），它内部再调用
 *                     nodejs-mobile 导出的 node::Start()
 */
final class NodeRunner {

    static {
        System.loadLibrary("birdnode");
    }

    private NodeRunner() {
    }

    /**
     * 启动 Node。
     *
     * 注意：这个调用会一直阻塞到 Node 的事件循环结束（对服务端来说就是一直不返回），
     * 所以必须在子线程里调用 —— 见 MainActivity.startNode()。
     *
     * @param argv    Node 的命令行参数，argv[0] 固定为 "node"
     * @param dataDir 缓存落盘目录，会以 BIRD_DATA_DIR 环境变量交给 Node
     * @return Node 的退出码
     */
    static native int startNode(String[] argv, String dataDir);
}
