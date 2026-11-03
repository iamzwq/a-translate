---
name: "release-notes"
description: "根据 Git 暂存区的代码改动生成面向用户的 Release 更新说明（新功能 / 问题修复 / 优化），并检查 manifest 版本号与 tag"
argument-hint: "可选：补充说明，如“忽略内部重构”"
agent: "agent"
---
根据当前仓库 Git 暂存区（Staged Changes）的代码改动，写一份可直接粘贴到 GitHub Release 页面的更新说明。用中文输出。

## 获取变更

- 运行 `git --no-pager diff --cached --stat` 和 `git --no-pager diff --cached` 获取改动；只看暂存区，不混入未暂存的修改。
- 暂存区为空时直接告知并结束。
- 必要时阅读改动文件的上下文，弄清改动对用户的实际效果。

## 写作要求

- 面向扩展的使用者，描述用户能感知到的变化，不写函数名、变量名等实现细节。
- 按以下分组输出，没有内容的分组省略：
  - `## 新功能`
  - `## 问题修复`
  - `## 优化`（性能、体验、资源占用等）
- 纯内部重构、注释、代码去重等用户无感知的改动不写。
- 每条一句话说清楚，必要时用子项补充细节；不夸大，不虚构暂存区里没有的改动。
- 整份说明放在一个 ```markdown 代码块中，方便复制。

## 发布前检查

在说明之后，简短提示以下问题（没有问题则不提）：

- [manifest.json](../../manifest.json) 的 `version` 是否在本次暂存区中更新；若未更新，对比最新 tag（`git describe --tags --abbrev=0`），提醒需要改版本号。
- 发布 tag 必须为 `v` + manifest 版本号（如 `v2026.11.3`），否则 [release workflow](../workflows/release.yml) 会因版本不一致而失败。
