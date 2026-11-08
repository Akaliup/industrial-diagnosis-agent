# PWA Icons

## 自动生成

PNG 图标通过 `npm --prefix web run generate-icons` 从统一源图自动生成。

## 图标源

- 首选：仓库根目录 `branding/industrial-diagnosis-icon-source.png`
- 回退：`logo-1024.png`（没有 `branding/` 的裁剪构建）
- 最后回退：`../favicon.svg`

脚本会从同一份源文件生成全部 PWA PNG 尺寸、Apple Touch Icon、Maskable Icon、
`logo-1024.png`，以及 Electron 的 `electron/assets/app-icon.png` 和
`electron/assets/app.icns`，避免维护内容重复的副本。

## 自定义图标

如需更新图标：

1. 替换 `branding/industrial-diagnosis-icon-source.png`（建议 1024×1024 以上）
2. 运行 `npm --prefix web run generate-icons` 重新生成全部平台图标
3. 不要单独编辑生成后的 PNG；下次生成会覆盖
