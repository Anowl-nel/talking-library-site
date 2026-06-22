# 会说话的图书馆

一个可以部署到 GitHub Pages 的私有知识库网页。

这个版本是纯静态站点：网页代码托管在 GitHub，私人文档默认只保存在当前浏览器的 IndexedDB 中，并使用你的知识库口令加密。它适合个人长期使用、备份和迁移；如果需要多设备同步、多人权限、真正的 GPT 后端，需要再接一个私有 API 服务。

## 功能

- 上传 PDF、DOCX、TXT、Markdown、JSON、CSV、日志和会议记录
- 浏览器本地解析和分片索引
- 本地引用式问答
- 本地加密资料库
- 加密备份导出和导入
- 可配置 AI 后端地址，用于连接自己的 GPT/RAG 服务
- GitHub Pages 自动部署工作流

## 本地打开

直接用浏览器打开 `index.html` 即可。

PDF 和 DOCX 解析依赖 CDN 脚本；如果离线使用，TXT、Markdown、JSON、CSV、日志仍可导入。

## 部署到 GitHub Pages

1. 在 GitHub 创建一个新仓库，例如 `talking-library-site`。
2. 把本目录推送到仓库的 `main` 分支。
3. 打开仓库 `Settings` -> `Pages`。
4. 在 `Build and deployment` 里选择 `GitHub Actions`。
5. 等待 `Deploy to GitHub Pages` 工作流完成。

常用命令：

```bash
git init
git add .
git commit -m "Initial talking library site"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/talking-library-site.git
git push -u origin main
```

## 隐私边界

- 上传的资料不会自动提交到 GitHub。
- 资料内容保存在当前浏览器本地，并用你的口令派生密钥加密。
- GitHub Pages 本身是静态托管，不提供服务器端私有数据库。
- 如果启用 AI 后端，发送给后端的内容取决于你的后端实现和配置。

## AI 后端协议

设置里的 AI 后端地址会收到如下 JSON：

```json
{
  "question": "问题",
  "model": "gpt-5.5",
  "context": [
    {
      "document": "meeting-notes.md",
      "chunkId": 1,
      "text": "相关片段"
    }
  ]
}
```

后端返回以下任一字段即可：

```json
{
  "answer": "带引用的答案"
}
```

或：

```json
{
  "text": "带引用的答案"
}
```
