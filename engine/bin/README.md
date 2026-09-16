# 引擎自带的 llama.cpp 运行时

这里的二进制来自 llama.cpp 官方发布，用于本地模型（离线翻译）的推理服务：

- `bin/`         — CPU 构建（纯 CPU 推理，任何机器可用）
- `bin-vulkan/`  — Vulkan 构建（把模型层卸载到显卡，需要显卡驱动支持 Vulkan）

两者是同一个版本：

```
version: 0.3.0-dev (build 10681, commit 77f132cb1)
built with Clang 20.1.8 for Windows x86_64
```

获取方式：llama.cpp 官方 release 的 `llama-<build>-bin-win-cpu-x64.zip` 与
`llama-<build>-bin-win-vulkan-x64.zip`，解压后整目录放进来即可（保持目录名不变）。

引擎的 `local_model.find_server_exe()` 只在这个目录里找：
`bin/` → `bin-vulkan/` 等后端变体（`bin-cuda`、`bin-rocm`…），
**有显卡时优先挑能认出显卡的那个**（`--list-devices` 能列出设备），
并自动加 `-ngl` 把层卸载到显存；显存不足启动失败会自动回退 CPU。
使用者需要提供的只有模型文件（.gguf），server 不用管。

许可：llama.cpp 为 MIT（见 `LICENSE`），再分发需保留该文件。
