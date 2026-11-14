# Windows 自签名与信任安装

[返回首页](../README.md) · [使用指南](USAGE.md) · [验证记录](VALIDATION.md)

QQ_Service 使用固定的 **QQ_Service Self-Signed Publisher** 证书为便携版签名。首次在自己的 Windows 用户中导入公开证书后，后续使用同一证书的版本可以沿用该信任。它不提供公共 CA 信任，也不保证消除 SmartScreen 或杀毒软件提示。

已发布的旧 v0.8.0 EXE 仍是未签名版本，不会因安装证书而变成已签名。普通 PR 预览也继续未签名；已签名包由通过检查的 `main` 构建产生，实际状态以对应工作流、文件签名和提交号为准。

## 下载并核对

在 [Windows 工作流](https://github.com/klwb360/QQ_Service/actions/workflows/windows.yml) 中打开成功的 `main` 构建，下载 **QQ_Service-Windows-x64-signed**。下载 Actions 产物需要登录 GitHub；当前保留期为14天。普通 `QQ_Service-Windows-x64` 是未签名预览，不要只根据 EXE 的版本号判断是否签名。

完整解压后，同一文件夹应有：

- 便携 EXE 及对应的 `.exe.sha256`；
- `QQ_Service.cer`、`certificate.json`；
- `Install-QQServiceTrust.ps1`、`Remove-QQServiceTrust.ps1`、`QQServiceTrust.Common.ps1`、`README.txt`；
- `signing-manifest.json`，记录源码提交、发布者和最终文件摘要。

先将 `signing-manifest.json` 中的源码提交与下载工作流的提交核对，再核对 EXE 的 SHA256。PowerShell 示例，文件名按包内版本调整：

```powershell
Get-FileHash .\QQ_Service-0.8.0-Windows-x64.exe -Algorithm SHA256
Get-Content .\QQ_Service-0.8.0-Windows-x64.exe.sha256
Get-Content .\signing-manifest.json
```

公开证书的 SHA256 应与 `certificate.json` 一致，并与仓库 [main 中的公开指纹](https://github.com/klwb360/QQ_Service/blob/main/signing/certificate.json) 核对。仓库只保存公开证书和指纹，不包含私钥。

```powershell
Get-FileHash .\QQ_Service.cer -Algorithm SHA256
Get-Content .\certificate.json
```

## 首次安装当前用户信任

在解压后的文件夹打开普通 PowerShell，运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-QQServiceTrust.ps1
```

请保留完整解压后的三个 PowerShell 脚本。安装脚本显示发布者及指纹，由你明确确认后，仅向当前用户的 `Root` 和 `TrustedPublisher` 证书库导入这张公开证书。无需管理员权限，不安装私钥，不修改整机证书库；重复运行不会重复添加。上面的执行策略参数仅作用于本次 PowerShell 进程，不永久改变系统策略。应用启动不会自动安装信任。

安装后核对 EXE：

```powershell
Get-AuthenticodeSignature .\QQ_Service-0.8.0-Windows-x64.exe |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

预期 `Status` 为 `Valid`，发布者为 `QQ_Service Self-Signed Publisher`，签名证书指纹与公开元数据一致。导入前可能显示 `NotTrusted`；缺少签名、指纹不符或文件摘要不符时，应重新核对下载来源和产物，不能用导入其他证书来绕过检查。

证书信任是 Windows 用户设置；远程构建无法替你在本机执行首次导入。后续更新只需核对来源、提交、摘要和签名，证书未更换时无需重复安装。

## 移除信任

需要撤销时，在保留公开证书及脚本的目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Remove-QQServiceTrust.ps1
```

脚本只移除当前用户信任库中与固定指纹相同的证书，不删除其他发布者证书，也不改动账号、密钥或聊天数据。重复移除不会扩大操作范围。移除后，旧 EXE 的签名仍存在，但本机可能不再信任它。

## 构建与私钥边界

证书使用 RSA-4096、SHA256，仅用于代码签名，有效期1095天。私钥的加密 PFX 与密码分别存放于 GitHub `windows-signing` 环境的 `WINDOWS_SIGNING_PFX_BASE64`、`WINDOWS_SIGNING_PASSWORD` Secrets，不通过聊天、仓库或下载包传递。

- GitHub 服务端将该环境限制为 `main`；普通 PR 不读取生产私钥，Windows 签名测试使用一次性证书。
- main 完整检查通过后，在独立 Windows 任务中构建。私钥临时导入运行器当前用户的 `My` 库，按固定公开指纹选择证书；不通过命令行传递 PFX 密码。
- `npm run build:exe:signed` 只签内部 `QQ_Service.exe` 与外层便携 EXE，使用 SHA256 和 RFC3161 时间戳。Node 等第三方 EXE 保持原始字节与签名。
- 全部签名结束后才在临时运行器中导入公开信任并验签；随后清理临时私钥及本次导入的证书。最终 EXE 的 SHA256 在签名完成后生成。
- 验证证书、时间戳或完整性失败时，签名构建失败，不把未签名文件当成已签名成功产物。
- 正式标签发布只复用**相同源码提交**的 main 已签名产物，不获取私钥。最多等待30分钟；缺失、过期或验证失败则停止，维护者需重跑对应 main 构建。

当前签名覆盖便携版。NSIS 安装包还需独立接入和验收，不能据此把原有未签名安装包标为已签名。实际 Windows 构建与测试结果见[验证记录](VALIDATION.md)。

## 维护者首次初始化

如果云端连接不能管理 GitHub Environment／Secrets，可在自己的 Windows 上从当前 PR 源码或 `QQ_Service-signing-setup` 产物下载 `Initialize-GitHubSigning.ps1`，在文件所在目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Initialize-GitHubSigning.ps1
```

它核验固定版本的官方便携 GitHub CLI，要求仓库所有者登录，先验证管理权限和 main-only 环境，再生成证书、上传加密 Secrets，并仅提交公开证书和元数据。临时私钥清理后只留 GitHub 中的加密副本；不会安装本机信任、自动换证或合并 PR。

看到 `SUCCESS` 后即可回到项目对话继续验收。若上传已完成而公开提交中断，使用 `-ResumePublicCommit` 只恢复公开提交，不能重新生成一套证书。完整操作及失败恢复见[初始化说明](../signing/SETUP.txt)。
