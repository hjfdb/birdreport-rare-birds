cmake_minimum_required(VERSION 3.22.1)
project(birdnode CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# nodejs-mobile 的预编译产物：bin/<abi>/libnode.so 与 include/node/*.h
#
# 正常由 app/build.gradle 用 -DNODEJS_MOBILE_DIR=… 传进来；
# 这里的默认值是单独跑 cmake 时的兜底（cpp → main → src → app → android）。
if(NOT DEFINED NODEJS_MOBILE_DIR)
    set(NODEJS_MOBILE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../third_party/nodejs-mobile")
endif()
message(STATUS "nodejs-mobile: ${NODEJS_MOBILE_DIR}")

if(NOT EXISTS "${NODEJS_MOBILE_DIR}/bin/${ANDROID_ABI}/libnode.so")
    message(FATAL_ERROR
            "找不到 ${NODEJS_MOBILE_DIR}/bin/${ANDROID_ABI}/libnode.so。"
            "先执行：node android/fetch-nodejs-mobile.mjs")
endif()

add_library(birdnode SHARED native-lib.cpp)

target_include_directories(birdnode PRIVATE "${NODEJS_MOBILE_DIR}/include/node")

# 直接链接预编译好的 libnode.so。
# 同一份 .so 也通过 jniLibs 打进 APK（app/build.gradle 里配置的
# sourceSets.main.jniLibs.srcDirs），这里只是拿它做链接。
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
        IMPORTED_LOCATION "${NODEJS_MOBILE_DIR}/bin/${ANDROID_ABI}/libnode.so")

find_library(log-lib log)

target_link_libraries(birdnode libnode ${log-lib} android)
