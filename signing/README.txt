QQ_Service：首次安装本机信任

这是项目自己的免费代码签名证书，仅对你主动信任它的 Windows 用户生效。
它不是公共 CA 证书，不保证消除 SmartScreen 提示，也不代表杀毒软件审查结论。

下载并完整解压已签名包。目录中应有 EXE、EXE.sha256、QQ_Service.cer、
certificate.json、signing-manifest.json、两个信任脚本和共享校验脚本。
这里不应包含 PFX、私钥或密码；无需向任何人提供这些信息。

首次运行：

1. 在解压目录打开 PowerShell，用 Get-FileHash -Algorithm SHA256 核对 EXE，
   与配套 .sha256 文件中的值比较。校验值应针对最后签名完成的 EXE。
2. 查看 signing-manifest.json 中的 sourceSha，打开对应 GitHub 提交的
   signing/certificate.json，并核对其中的 sha256 与本地 certificate.json。
   仓库：https://github.com/klwb360/QQ_Service
3. 在当前目录执行：

   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\Install-QQServiceTrust.ps1"

4. 再次核对脚本显示的发布者、SHA256 指纹和有效期，确认后同意导入。
   发布者应为 QQ_Service Self-Signed Publisher。
5. 运行 EXE。后续使用同一证书签名的版本通常不需要再次导入。

上述 ExecutionPolicy Bypass 仅用于本次 PowerShell 进程，不会永久修改策略。
脚本仅操作当前用户的 Root 和 TrustedPublisher；不需要管理员权限，
不操作 LocalMachine 或个人私钥库。应用启动时不会自动安装证书。
确认后通过 Windows 的 CryptUIWizImport 非交互接口导入已校验的公开证书。
静态校验脚本在独立 PowerShell 子进程执行，单次导入设有超时，
不会在后台无限等待系统对话框，也不会调用任意下载的证书工具。
若组织策略要求交互或管理员管理信任，脚本会停止并给出错误，不会修改系统策略。
单位电脑的组织策略若阻止导入，请交由管理员处理；不要改成整机导入。

只查看将执行什么，不修改信任：

   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\Install-QQServiceTrust.ps1" -WhatIf

移除本证书的信任：

   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\Remove-QQServiceTrust.ps1"

移除脚本只删除与随包证书 SHA256 完全一致的当前用户信任条目，不删除其他
发布者，也不删除个人私钥。重复安装或移除可安全执行；过期证书仍可移除。
证书更新时应先核对新指纹，再主动导入；脚本不会自动信任替换的证书。
