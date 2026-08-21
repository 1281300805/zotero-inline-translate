# Zotero 页面内翻译（Inline Translate for Zotero）

一个面向 Zotero 8–9 的 PDF 页面内翻译插件。选中 PDF 中的一段或多个不连续区域后，插件调用 DeepSeek 翻译，并在原文坐标上直接绘制中文译文。

译文只是 Zotero 阅读器中的视觉覆盖层：不会修改原始 PDF，也不会额外生成一份翻译 PDF。

## 功能

- 选中文字后，通过“翻译并替换（DeepSeek）”直接覆盖原文
- 支持连续保留多个不相邻区域，再按阅读顺序合并翻译
- 支持跨栏、跨位置和跨页选区
- 尽量继承原文的字号、粗体、斜体和字体类别
- 保留引用编号、公式、英文缩写、URL 和段落结构
- 单击译文临时切换回原文，右键删除当前译文
- 阅读器工具栏可以显示、隐藏或清除当前 PDF 的全部译文
- 缩放、旋转或重新打开 PDF 后恢复译文
- 将 Zotero 高亮注释跟随映射到对应译句；在中英文视图间切换时保留注释定位
- 相同选区重新翻译时替换旧记录，避免重复叠加

## 兼容性

- Zotero 8 或 Zotero 9
- PDF 必须包含可选择的文字层；纯扫描 PDF 需要先进行 OCR
- 翻译服务默认为 DeepSeek，也可以填写兼容 OpenAI `chat/completions` 接口的地址与模型

## 安装

### 从 GitHub Release 安装（推荐）

1. 打开本仓库的 [Releases](https://github.com/1281300805/zotero-inline-translate/releases/latest)。
2. 下载 `inline-translate-for-zotero.xpi`。
3. 在 Zotero 中打开“工具 → 插件”。
4. 把 `.xpi` 文件拖入插件窗口，或从齿轮菜单选择“从文件安装插件”。
5. 安装完成后完全重启 Zotero。

Zotero 官方的插件安装说明见 [Plugins for Zotero](https://www.zotero.org/support/plugins)。

### 更新

下载 Releases 中的新版本 `.xpi`，按上述方法重新安装即可覆盖旧版本。覆盖层数据和插件设置不会因为正常升级而删除。

## 配置 DeepSeek

1. 登录 [DeepSeek 开放平台](https://platform.deepseek.com/)，在 [API Keys](https://platform.deepseek.com/api_keys) 页面创建密钥。
2. 打开 Zotero 设置中的“页面内翻译 / Inline Translate”。
3. 填写以下内容：

   | 设置     | 推荐值                     |
   | -------- | -------------------------- |
   | API 地址 | `https://api.deepseek.com` |
   | API Key  | 在 DeepSeek 平台创建的密钥 |
   | 模型     | `deepseek-v4-flash`        |
   | 目标语言 | `简体中文`                 |

4. 点击“测试连接”。

插件会自动为默认 API 地址补充 `/chat/completions`。DeepSeek 当前接口和模型说明可查看其[官方快速入门](https://api-docs.deepseek.com/quick_start/pricing-details-cny/)。如果使用其他兼容服务，请同时修改 API 地址和模型名。

> [!IMPORTANT]
> 不要把 API Key 写入源码、README、Issue 或提交记录。本项目不会包含你的 API Key；密钥保存在当前电脑的 Zotero 本地配置中。

## 使用方法

### 翻译一个区域

1. 在 Zotero PDF 阅读器中拖选文字。
2. 点击“翻译并替换（DeepSeek）”。
3. 翻译完成后，译文会立即显示在原文位置。

### 翻译多个不连续区域

1. 选中第一个区域。
2. 点击“保留此区域，继续选择”。
3. 松开鼠标，在另一栏、另一位置或下一页继续选择。
4. 重复上述步骤，然后点击“翻译全部 N 个区域（DeepSeek）”。

插件会按页面和阅读坐标排列这些区域，合并发送翻译，同时避开没有选择的图、页脚或其他文字。

### 查看、删除和管理译文

- 左键单击任意译文区域：切换显示原文
- 右键单击译文区域：删除该段译文
- 阅读器工具栏“译文”按钮：显示或隐藏全部译文
- 右键工具栏“译文”按钮：清除当前 PDF 的全部译文

## 注释跟随

插件会读取与翻译区域相交的 Zotero 高亮或下划线注释，并把注释范围映射到对应译句：

- 从英文注释句切换到中文时，注释框跟随到中文译句
- 从中文注释句切回英文时，恢复原始英文注释及弹窗
- 点击没有注释的译文区域时，只切换语言，不主动打开其他注释

句子数量一致时按句序一一映射；翻译发生合句或拆句时使用有序回退映射。

## 数据、隐私与备份

- 选中的文本会发送给你配置的翻译 API 服务
- API Key 仅保存在本机 Zotero 配置中
- 原始 PDF 不会被修改
- 译文覆盖层保存在 Zotero 数据目录下的 `inline-translate-overlays.json`
- 覆盖层文件目前不参与 Zotero 同步

换电脑时，最简单的恢复方式是重新安装 XPI 并重新填写 API Key。如果还要保留已有页面译文，请关闭 Zotero，把旧电脑 Zotero 数据目录中的 `inline-translate-overlays.json` 复制到新电脑相同的数据目录。建议复制前先备份两端文件，避免覆盖新电脑已经生成的译文。

## 已知限制

- 纯图片扫描 PDF 无法直接选择文字
- PDF 文本坐标或阅读顺序错误时，跨栏选区可能仍需分成多个区域
- 译文比原文长时，插件可能缩小字号；译文较短时会保留空白
- 页面内译文不会出现在导出或打印的原 PDF 中
- 插件依赖 Zotero Reader 的内部结构，Zotero 大版本更新后可能需要适配

## 从源码构建

需要安装 Git、Node.js 和 npm。

```powershell
git clone https://github.com/1281300805/zotero-inline-translate.git
cd zotero-inline-translate
npm.cmd ci
npm.cmd run test:unit
npm.cmd run lint:check
npm.cmd run build
```

构建产物位于：

```text
.scaffold/build/inline-translate-for-zotero.xpi
```

macOS 或 Linux 可以把示例中的 `npm.cmd` 换成 `npm`。

## 项目结构

```text
addon/                           插件清单、设置界面和本地化文本
src/modules/deepseek.ts          DeepSeek API 调用
src/modules/readerOverlays.ts    PDF 选区、排版、交互和注释跟随
src/modules/overlayStore.ts      译文覆盖层的本地持久化
src/modules/annotationMapping.ts 注释句子映射
test/                            回归测试
```

## 开发检查

```powershell
npm.cmd run test:unit
npm.cmd run lint:check
npm.cmd run build
```

GitHub Actions 会在推送和 Pull Request 时自动运行单元测试、代码规范检查与构建。

## 安全说明

Zotero 插件对 Zotero 数据和本机拥有较高权限。请只安装自己构建的版本或本仓库 Releases 中的版本，并妥善保管 DeepSeek API Key。

## 许可证

本项目使用 [GNU Affero General Public License v3.0](LICENSE)。项目基于 [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) 构建。
