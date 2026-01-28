# Trae 安装教程

本教程将指导您完成 Trae 与 AntiDebug_Breaker_mcp 插件的配置过程。

---

## 一、下载与安装 Trae

Trae 提供两个版本供您选择：

| 版本 | 下载地址 | 说明 |
|------|----------|------|
| 国内版 | [https://www.trae.cn/](https://www.trae.cn/) | 推荐国内用户使用 |
| 国际版 | [https://www.trae.ai/](https://www.trae.ai/) | 海外用户使用 |

> 💡 **提示：** 如果不确定选择哪个版本，建议下载国内版。

**安装步骤：**

1. 访问上述官网下载并安装 Trae
2. 登录您的账号
3. 打开任意一个项目

---

## 二、安装 AntiDebug_Breaker 插件

您可以选择以下任一方式安装浏览器插件：

### 方式一：从源码安装

1. 下载或克隆项目到本地
2. 打开 Chrome 浏览器，访问 `chrome://extensions/`
3. 开启右上角的「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择源码文件夹即可

### 方式二：从 Release 下载

前往 [Releases](https://github.com/vs-olitus/AntiDebug_Breaker_mcp/releases) 页面下载最新版本的压缩包并解压。

### 安装 MCP 服务依赖

无论使用哪种方式，安装完成后都需要执行以下命令安装依赖：

```bash
# 进入 MCP 服务器目录
cd /你的路径/AntiDebug_Breaker_mcp/mcp-server

# 安装依赖
npm install
```

> 💡 **提示：** 请等待依赖安装完成后，再进行下一步的 MCP 服务配置。

---

## 三、配置 MCP 服务

### 步骤 1：添加 MCP 服务器

点击右上角 **设置** → 找到 **MCP** → 点击进入配置页面

![](https://niuniu-1322388865.cos.ap-nanjing.myqcloud.com/admcp/20260128153119242.png)

### 步骤 2：编辑配置文件

将以下 JSON 配置代码输入到指定位置，然后点击确定：

```json
{
  "mcpServers": {
    "AntiDebug_Breaker_mcp": {
      "command": "node",
      "args": ["/你的地址/AntiDebug_Breaker_mcp/mcp-server/dist/index.js"],
      "env": {
        "MCP_PORT": "9527"
      }
    }
  }
}
```

> ⚠️ **注意事项：**
> - 将 `/你的地址/` 替换为您实际的安装路径
> - `MCP_PORT` 端口号必须与插件配置保持一致
> - 配置完成后点击确定保存文件

![](https://niuniu-1322388865.cos.ap-nanjing.myqcloud.com/admcp/20260128153119243.png)

### 步骤 3：启用 MCP 服务

1. 返回 **MCP** 页面
2. 找到名为 `AntiDebug_Breaker_mcp` 的服务
3. 在右侧对话栏勾选 **Builder with MCP 服务器**

![](https://niuniu-1322388865.cos.ap-nanjing.myqcloud.com/admcp/20260128153119244.png)

---

## 四、配置浏览器插件

### 步骤 1：启用 MCP 功能

1. 打开已安装的 AntiDebug_Breaker 插件设置页面
2. 找到 MCP 配置选项并开启
3. 确保端口号与 Trae 中配置的端口一致（如：`9527`）
4. 点击 **启动 MCP**

### 步骤 2：确认连接状态

等待片刻后，插件应显示：

> ✅ **状态：已连接（端口：9527）**

![插件配置](https://s1.galgame.fun/imgb/u55/20260128_69799d679b0e2.png)

---

## 五、验证配置

配置完成后，随意打开一个网站，然后回到 Trae 对话页面进行测试。

**测试命令：**
```
请帮我调用 AntiDebug_Breaker_mcp 获取当前网站的 title 标题
```

如果配置正确，将成功返回当前网页的标题信息。

![](https://niuniu-1322388865.cos.ap-nanjing.myqcloud.com/admcp/20260128153119245.png)

---

## 🎉 配置完成

恭喜！至此 Trae 与 AntiDebug_Breaker_mcp 的配置已全部完成，您现在可以开始使用了！

---

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| 显示"未连接"状态 | 检查端口号是否与插件配置一致 |
| MCP 服务启动失败 | 确认 Node.js 已正确安装，路径配置正确 |
| 插件无法连接 | 尝试重启浏览器和 Trae |