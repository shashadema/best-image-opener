# 原图助手 · Best Image Opener

右键图片时，自动找到并打开**可获取的最高画质版本**。它解决的不只是“把 `small` 改成 `large`”，还包括现在网站常见的懒加载、`srcset`、`<picture>`、CSS 背景图和透明覆盖层。

> 这是一个 Chrome MV3 扩展。油猴版只是同源码生成的轻量降级方案，见文末对比。

---

## 安装（Chrome / Edge）

Chrome 不允许命令行静默安装未上架扩展，最后一步必须由你在扩展管理页确认：

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择本目录 `best-image-opener`（里面直接有 `manifest.json`）
5. 建议把工具栏上的「原图助手」图标固定出来

也可以解压分享包 `原图助手-1.0.5.zip` 后选择解压出来的文件夹。

安装后打开 `demo/index.html`（或起一个本地服务器）逐张右键测试。直接双击 `file://` 打开时，需要在扩展详情里打开 **允许访问文件网址**。

---

## 怎么用

- 在图片上右键 → **打开原图（新标签页）**
- 也可以继续用 Chrome 自带的 **在新标签页中打开图片**，扩展会让它指向原图
- 背景图、透明覆盖层上的图片，右键也能出现图片菜单
- 在图片上 **Alt + 右键**：跳过本扩展，使用网站自己的右键行为
- 点工具栏图标：可对当前网站单独停用，或调整三个常用开关

右键菜单里还有：

- **复制原图地址**
- **下载原图**（防盗链严格的站点可能失败，失败时用“打开原图”再右键保存）

设置页可调整：接管原生菜单、解除右键限制、Referer、直接替换页面图片、提示、后台打开、网站例外。

---

## 它做了什么

### 1. 找“更真的”地址

按优先级综合判断：

- `srcset` 里最大的候选（按 `w` / `x` 描述符）
- `<picture><source srcset>` 
- `data-original` / `data-src` / `data-actualsrc` / `data-lazy-src` 等懒加载属性
- 图片外层 `<a href="....jpg">` 指向的原图
- CSS `background-image`
- 各站点 CDN 的 URL 规律

站点规则集中在 [`src/resolver.js`](src/resolver.js)，目前已覆盖：

| 站点 | 处理 |
| --- | --- |
| 微博 / 新浪图床 | `orj360` / `mw690` / `large` 等 → `oslarge`（无水印原图） |
| 知乎 | `_1440w` / `_b` / `_hd` 等 → `_r` |
| 哔哩哔哩 | 去掉 `@480w_270h_1c.webp` 这类后缀 |
| 淘宝 / 天猫 | 去掉 `_400x400.jpg`、`_.webp`、`_q90.jpg` |
| 京东 | `n1` / `s800x800_jfs` → `n0` / `jfs`；`n1/s450x450_jfs` 组合路径同时去掉尺寸段 |
| 小红书 | 签名 `sns-webpic-qc` → 公开 `sns-img-*` 原图直链，优先 JPEG 高清版（`!nd_dft_wlteh_jpg_1`） |
| 酷我音乐 | 专辑封面尺寸目录 → 无尺寸原图路径，并保留高清尺寸回退 |
| 酷狗音乐 | `stdmusic` / `custom` / `mvhdpic` 等尺寸目录 → 无尺寸原图路径 |
| QQ 音乐 | `T00xR300x300...` → `T00xM000...` 原图，保留 1200/800 回退 |
| 网易云音乐 | 移除 `param=200y200` 等封面缩略参数 |
| 豆瓣 | `s_ratio_poster` / `s` → `l_ratio_poster` / `l` |
| X / Twitter | `name=small` → `name=orig` |
| Pinterest | `236x` / `736x` → `originals` |
| Pixiv | `img-master` `_master1200` → `img-original` |
| 微信公众号 | `/640?wx_fmt=...` → `/0?wx_fmt=...` |
| Wikipedia | `thumb.wikimedia.org/.../thumb/.../250px-x.jpg` → `upload.wikimedia.org/.../x.jpg` |
| Google 相册 / 头像 | `=w200-h200` → `=s0` |
| Imgur | `abc1234h.jpg` → `abc1234.jpg` |
| Medium | `resize:fit:1200` → `resize:fit:4000` |
| Substack | 拆开 `image/fetch/.../https%3A%2F%2F...` 嵌套地址 |
| ArtStation | `smaller_square` / `micro_square` → `large` |
| 花瓣网 | `_fw192webp` / `_fw480webp` / `_fw658` 等尺寸后缀 → 去掉后缀取原始上传 |
| 通用 | WordPress `-300x200`、`x-oss-process`、`imageView2` 等缩放参数 |

签名地址（Instagram、Facebook、抖音等）不会乱改：地址与签名绑定，改一个字符就 403，扩展会保留原地址。

### 2. 让 Chrome 自带菜单也使用原图

Chrome 原生菜单读取的是鼠标下的 `<img>`。扩展会先预加载一层 **1% 透明度、同样大小的代理 `<img>`**，只有加载成功后才放到右键位置；外面再包一层原 `<a>`，这样“打开链接”等原生菜单项也不会丢。未加载完成或失败的代理图不会插入页面，因此正常图片不会因此多出 Chrome 原生的“加载图片”。

代理层会在下一次点击、滚动、Esc 或 15 秒后自动移除。

### 3. 解除右键限制

在 `window` 捕获阶段拦掉网站的 `contextmenu` 拦截器，但**不**调用 `preventDefault`，所以 Chrome 原生菜单照常弹出。

按住 Alt 右键可完全跳过扩展，保留网站自定义菜单。

### 4. 防盗链

打开原图的新标签页时，通过 `declarativeNetRequest` 的 **session rule** 只给这个 `tabId` 设置 `Referer` 为原页面地址，标签页关闭即删除规则。不会影响其他标签页，也不会常驻。

---

## 已知限制

- **签名 CDN**：Instagram、Facebook、抖音等地址带签名，无法仅凭 URL 还原原图。
- **小红书**：不猜测 `sns-img-*` 公共地址或 `imageView2` 参数，保留页面当前图片地址，避免跳转到 1603005 资源不存在页。
- **Canvas 绘制的图片**：跨域 canvas 受 CORS 限制，无法安全导出。
- **极老微博图**：个别老图没有 `oslarge`；打开后会检测该标签页是否真的加载出图片，失败则自动按候选顺序回退到 `woriginal` / `large` 等。
- **下载**：`chrome.downloads` 不能带 Referer，防盗链严格的站点请用“打开原图”后另存。
- **网站自定义菜单**：代理层会让图片上的站点自定义右键菜单失效；Alt + 右键或站点例外可解决。
- 扩展需要 `<all_urls>` 权限才能在所有站点工作，但**没有任何联网上报**，只在你主动打开图片时请求图片本身。

---

## 油猴 vs Chrome 扩展

**不是必须用油猴。** 这个需求更适合扩展：

| 能力 | Chrome 扩展（本方案） | 油猴脚本 |
| --- | --- | --- |
| 出现在 Chrome 原生图片右键菜单 | ✅ `contextMenus` | ❌ 只能借助原生项或自绘菜单 |
| 让 Chrome 自带“打开图片”用原图 | ✅ 代理层 | ✅ 同样可以 |
| 防盗链 Referer（按标签页、自动清理） | ✅ DNR | ❌ 页面脚本改不了 Referer |
| 背景图 / 覆盖层 | ✅ | ✅ |
| 站点例外 / 开关 UI | ✅ | 需自己写 UI |
| 安装 | 开发者模式加载，需一次手动确认 | 点一下安装 |
| 更新 / 维护 | 改文件后点“重新加载” | 改脚本即可 |
| 权限范围 | 全站 host 权限 | 全站 match |
| 跨浏览器 | Chrome / Edge | 理论上有油猴即可 |

**结论：** 日常使用装扩展；油猴版适合“不想装扩展 / 临时在别人电脑上用 / 只需要最基础 URL 升级”的场景。

轻量油猴版在同目录 [`userscript/best-image.user.js`](userscript/best-image.user.js)，由扩展源码自动生成，功能少了原生菜单和 Referer，防盗链站点可能打不开。

---

## 开发与测试

纯 URL 逻辑在 `src/resolver.js`，不依赖 DOM 或 `chrome.*`，可单独测试：

```bash
node --test tests/resolver.test.js
node tools/build-userscript.mjs
```

- `demo/index.html`：本地右键测试页（懒加载、srcset、picture、背景图、覆盖层、右键拦截）
- `tools/cdp-e2e.mjs`、`tools/cdp-sw-test.mjs`：可选的 Chrome for Testing 端到端测试脚手架，需要本地 `http://127.0.0.1:8123` 和调试端口

目录：

```
manifest.json
src/
  resolver.js      纯 URL 规则 + srcset 解析
  content.js       右键、代理层、背景图、解除限制
  background.js    原生菜单、Referer、剪贴板、下载
  popup.html/js    工具栏弹窗
  options.html/js  设置页
  offscreen.*      剪贴板
icons/
demo/              本地测试页
tests/             单元测试
tools/             构建 / 端到端测试
userscript/        自动生成的油猴版
dist/              打包 zip
```

隐私：不收集、不上传任何数据。所有逻辑在本地浏览器内完成。

MIT License.
