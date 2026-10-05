# GitHub Release 安装与完整性校验

目标宿主是 **dsh 0.2.0-rc.2**。预构建 `.tgz` 包内必须包含 JS、Cordis patch、Windows helper 与自包含 .NET 运行时；源码仓库的自动生成 `Source code.zip` / `tar.gz` 不是这个安装包。

## 推荐：校验下载，再安装本地包

在本仓库目录中执行，版本必须明确指定；例如下载已经发布的 0.1.1：

```powershell
node scripts/download-release.mjs --version 0.1.1 --out-dir "$env:USERPROFILE\Downloads\cpuse"
```

脚本查询同一 GitHub Release 的资产元数据，核对版本、附件名称、下载 URL、大小和 GitHub 提供的 SHA-256，下载完成才输出 `.tgz` 的绝对路径。把输出路径粘贴到 DSH「插件 → 安装」。Windows 上采用 PowerShell 的系统 HTTPS/代理设置进行传输，参数通过 JSON stdin 传递，下载内容仍由 Node 校验。脚本只下载，不修改 DSH profile、不执行下载包中的代码。已有同名文件不会覆盖；重新下载时指定另一个目录，或自行处理旧文件。

使用 CLI 的人也可以把脚本输出的绝对路径交给当前 profile，例如：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile cpuse add "C:\Users\your-name\Downloads\cpuse\dsh-plugin-cpuse-0.1.1.tgz"
```

保留已校验 `.tgz`，profile 的本地 `file:` 依赖在重装时仍需要它。目标机器不需要 .NET SDK，也不需要放行插件构建脚本；其他依赖仍遵循宿主自己的供应链策略。

若旧 Release 没有资产 `digest`，脚本会停止。可以从已信任的发布校验文件取得 SHA-256 后加 `--sha256 <64位十六进制值>`。不要使用下载之后自行计算的值作为“预期值”，也不要关闭完整性校验。GitHub 资产摘要是同一发布平台提供的校验依据，不是独立代码签名。

## HTTP 链接报缺少 integrity 的原因

`ERR_PNPM_MISSING_TARBALL_INTEGRITY` 表示 **pnpm 的锁文件中，远程 tarball 的 resolution 缺少预期完整性摘要**。它不是插件运行时报错，也不能证明 GitHub 下载失败。插件还没有被加载，因此修改 `src/index.ts` 或原生 helper 不能修复这个安装阶段。

pnpm 历史版本存在 URL/tarball 依赖重解析时丢失摘要的问题；也可能是旧的或损坏的锁文件被复用。当前机器的隔离测试使用 **pnpm 11.22.0**，直接添加下面已发布的链接成功，并在锁文件中记录 SHA-512：

```text
https://github.com/Arialnya/cpuse/releases/download/v0.1.1/dsh-plugin-cpuse-0.1.1.tgz
```

随后 `pnpm install --frozen-lockfile --offline` 成功。只在隔离副本中去掉该远程条目的 `integrity`，就能复现同一错误码。这说明链接本身可安装；用户失败环境的 pnpm 版本与实际 profile 锁文件仍须核对。

DSH 桌面端可能使用应用自带的包管理器；系统 PATH 中 `pnpm --version` 与它不一定相同。请从安装诊断确认宿主实际使用的版本。升级全局 pnpm 不能保证替换桌面端的自带版本。不能仅靠 `--no-frozen-lockfile` 补救：缺少摘要的旧锁文件也可能在重新解析前被拒绝。

对本次失败的新安装，DSH 管理器会恢复安装前的 manifest/lockfile，可以直接尝试上面的已校验本地包。如果安装前锁文件本身已有损坏，可使用下面的定点修复；不要手写猜测的摘要，不要清除整个 profile，也不要放松 `verifyStoreIntegrity`、`trustPolicy` 或构建审批来掩盖报错。

依据：[pnpm 完整性规则安全公告](https://github.com/pnpm/pnpm/security/advisories/GHSA-q6j5-fjx5-2mc3)、[URL tarball 摘要丢失问题](https://github.com/pnpm/pnpm/issues/14351)、[dsh-plugin-manager 0.2.0-rc.2 发布包](https://www.npmjs.com/package/@deepseek-ai/dsh-plugin-manager/v/0.2.0-rc.2)。本地发布包的 `operations.js` 确认 rc.2 管理器转发 `pnpm add`，安装失败时恢复 profile manifest 与锁文件。

## 已损坏锁文件：只补 cpuse 的可信摘要

在克隆的新源码中先运行 `npm ci`，安装维护脚本用到的 YAML 解析器。**先关闭目标 DSH profile 和它的包管理操作**，从该宿主的安装诊断找到真实 profile 目录；桌面端 profile 位置可能不同，不要猜测路径。脚本不自动搜索、选择或修改 profile。

先用下载脚本取得同版本 `.tgz` 和 GitHub 资产 SHA-256。以下是针对用户报错中的旧版 **0.1.1** 的修复示例：

```powershell
# 把下面两个路径替换为你的真实 profile 锁文件、已下载的完整安装包
$cpuseLockfile = 'C:\path\to\profile\pnpm-lock.yaml'
$cpuseTarball = 'C:\path\to\downloads\dsh-plugin-cpuse-0.1.1.tgz'
$cpuseUrl = 'https://github.com/Arialnya/cpuse/releases/download/v0.1.1/dsh-plugin-cpuse-0.1.1.tgz'
$cpuseSha256 = 'ada5da84c716829acea434dc4ddab600d1a2cf189f7e5b05af1d8cbf3601311a'

# 先预览：不写入任何锁文件
node scripts/repair-lockfile.mjs --lockfile $cpuseLockfile --url $cpuseUrl --tarball $cpuseTarball --sha256 $cpuseSha256

# 确认 path/url 对应报错的 profile 和附件后，才写入
node scripts/repair-lockfile.mjs --lockfile $cpuseLockfile --url $cpuseUrl --tarball $cpuseTarball --sha256 $cpuseSha256 --write
```

`--write` 前，脚本核对完整 `.tgz` 的可信 SHA-256，检查其包名、版本、预编译运行时与 rc.2 依赖，重新计算 SHA-512，再只给 `packages` 中该 cpuse URL 的 `resolution` 补缺失的 `integrity`。它保存原锁文件的逐字节备份，保留所有其他条目、注释和换行，检查写入前的并发变化；已有不同摘要、目标不唯一、别名或不明确的 YAML 都会拒绝。默认只是预览；已经正确的条目不会再写入。脚本不改变 manifest、依赖版本、构建批准或供链政策，也不运行包管理器。

备份路径会出现在输出的 `backup` 字段。修复后再用 **宿主自己的** 插件安装/重装操作；CLI 用户可在已知的同一 profile 下执行 `dsh plugin --profile <name> install --frozen-lockfile`。不要同时打开应用安装器和手动 pnpm 操作。

本机验证记录：pnpm **11.22.0** 干净目录直接 URL 安装成功；随后正常 frozen/offline 安装成功；只删除 cpuse 摘要后在线 frozen 报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`。`install --fix-lockfile --no-frozen-lockfile` 仍被同一校验拒绝；`add --no-frozen-lockfile` 在这个版本不是合法参数。因此不推荐用这些参数“绕过”报错。运行定点修复后，再次 frozen/offline 安装成功，锁文件中的 SHA-512 为：

```text
sha512-Vsft6mNKhece2uaYQMamTOzY3E4OxB4rsehqq9NTMfNobN52fGrbSRV+puMd+OZE9CphADMd0VSvUDMJVLfyRA==
```

该值只适用于上述 GitHub **0.1.1** 附件。新版本必须用新资产的预期 SHA-256 和完整 tarball，不能复用它。本次验证只操作隔离测试目录，没有读取或修改用户真实 profile；没有把纯 pnpm 的安装测试称为桌面应用端到端安装验收。

## 发布者：生成预构建包与校验附件

```powershell
npm ci
npm test
npm run test:native
npm pack
node scripts/release-manifest.mjs .\dsh-plugin-cpuse-<version>.tgz
```

最后一条检查包内预编译 JS、Windows helper、.NET 运行时与固定 rc.2 依赖，生成两个与 `.tgz` 同名的附加文件：`.tgz.sha256`、`.tgz.release.json`。JSON 包含确切版本、下载 URL、字节数、SHA-256 和 pnpm 使用的 SHA-512 SRI。脚本拒绝源码包和版本不匹配的文件名；不会上传文件。

将这三个文件一并上传到 **相同版本** 的 GitHub Release，例如 tag `v0.1.2` 对应 `dsh-plugin-cpuse-0.1.2.tgz`。每次修改代码都发布新版本，不替换已经发布的同版本 `.tgz`。`prepack` 完成构建，用户安装预构建 tarball 不需要再次运行构建。仓库无需提交 `lib/` 或依赖缓存。

发布后，在空目录里验证实际公开下载链接的安装和第二次 frozen 安装，并核对该 tarball 的 lockfile resolution 包含 `integrity`。下载脚本也应对实际已上传附件再跑一次。本次尚未上传新版本，旧 0.1.1 Release 与新源码是不同产物。

安装脚本测试：`node --test tests/installation.test.mjs`。**16 项通过**，覆盖缺少摘要、摘要冲突、下载篡改/截断、HTTP 失败、拒绝覆盖文件、错误发布身份、缺少预编译运行时、破损 tar/PAX 与版本偏差、逐字节保留其他锁文件内容、默认预览、可信摘要要求、完整备份与并发修复拒绝；测试不会修改任何真实 profile。
