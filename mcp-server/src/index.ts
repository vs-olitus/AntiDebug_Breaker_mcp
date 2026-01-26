#!/usr/bin/env node
/**
 * AntiDebug Breaker MCP Server
 * 
 * 这个MCP服务器允许Cursor通过Chrome扩展来分析和控制浏览器页面
 * 
 * 功能：
 * - 获取当前页面信息（URL、标题、DOM结构等）
 * - 获取网络请求/API调用记录
 * - 获取Vue Router路由信息
 * - 注入和管理Hook脚本
 * - 获取Hook捕获的数据
 * - 控制页面导航
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";

// ============== 类型定义 ==============
interface PageInfo {
  url: string;
  title: string;
  hostname: string;
  protocol: string;
  pathname: string;
}

interface NetworkRequest {
  id: string;
  method: string;
  url: string;
  timestamp: number;
  headers?: Record<string, string>;
  body?: string;
  response?: {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  };
}

interface VueRouterData {
  vueVersion: string;
  routerMode: string;
  routes: Array<{
    path: string;
    name?: string;
    meta?: Record<string, any>;
  }>;
  currentRoute?: {
    path: string;
    name?: string;
    params?: Record<string, any>;
    query?: Record<string, any>;
  };
}

interface HookData {
  scriptId: string;
  timestamp: number;
  type: string;
  data: any;
  stack?: string;
}

interface BrowserState {
  connected: boolean;
  pageInfo?: PageInfo;
  networkRequests: NetworkRequest[];
  vueRouterData?: VueRouterData;
  hookData: HookData[];
  enabledScripts: string[];
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

// ============== 全局状态 ==============
let browserState: BrowserState = {
  connected: false,
  networkRequests: [],
  hookData: [],
  enabledScripts: [],
  cookies: {},
  localStorage: {},
  sessionStorage: {}
};

let browserClient: WebSocket | null = null;
let pendingRequests = new Map<string, {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: NodeJS.Timeout;
}>();

// ============== WebSocket 服务器 ==============
const WS_PORT = 9527;
const wss = new WebSocketServer({ port: WS_PORT });

console.error(`[MCP] WebSocket服务器启动在端口 ${WS_PORT}`);

wss.on("connection", (ws) => {
  console.error("[MCP] 浏览器扩展已连接");
  browserClient = ws;
  browserState.connected = true;

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleBrowserMessage(message);
    } catch (e) {
      console.error("[MCP] 解析消息失败:", e);
    }
  });

  ws.on("close", () => {
    console.error("[MCP] 浏览器扩展断开连接");
    browserClient = null;
    browserState.connected = false;
  });

  ws.on("error", (error) => {
    console.error("[MCP] WebSocket错误:", error);
  });
});

// 处理来自浏览器的消息
function handleBrowserMessage(message: any) {
  const { type, requestId, data, error } = message;

  // 处理请求响应
  if (requestId && pendingRequests.has(requestId)) {
    const pending = pendingRequests.get(requestId)!;
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);
    
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(data);
    }
    return;
  }

  // 处理推送消息
  switch (type) {
    case "PAGE_INFO":
      browserState.pageInfo = data;
      break;

    case "NETWORK_REQUEST":
      browserState.networkRequests.push(data);
      // 保留最近1000条请求
      if (browserState.networkRequests.length > 1000) {
        browserState.networkRequests = browserState.networkRequests.slice(-1000);
      }
      break;

    case "VUE_ROUTER_DATA":
      browserState.vueRouterData = data;
      break;

    case "HOOK_DATA":
      browserState.hookData.push(data);
      // 保留最近500条Hook数据
      if (browserState.hookData.length > 500) {
        browserState.hookData = browserState.hookData.slice(-500);
      }
      break;

    case "SCRIPTS_UPDATED":
      browserState.enabledScripts = data.enabledScripts || [];
      break;

    case "STORAGE_DATA":
      if (data.cookies) browserState.cookies = data.cookies;
      if (data.localStorage) browserState.localStorage = data.localStorage;
      if (data.sessionStorage) browserState.sessionStorage = data.sessionStorage;
      break;

    default:
      console.error("[MCP] 未知消息类型:", type);
  }
}

// 发送请求到浏览器并等待响应
function sendToBrowser(type: string, data?: any, timeout = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!browserClient || browserClient.readyState !== WebSocket.OPEN) {
      reject(new Error("浏览器扩展未连接。请确保Chrome扩展已加载并打开了目标页面。"));
      return;
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    const timeoutHandle = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`请求超时: ${type}`));
    }, timeout);

    pendingRequests.set(requestId, { resolve, reject, timeout: timeoutHandle });

    browserClient.send(JSON.stringify({
      type,
      requestId,
      data
    }));
  });
}

// ============== MCP 服务器 ==============
const server = new McpServer({
  name: "antidebug-breaker-mcp",
  version: "1.0.0"
});

// ============== 工具定义 ==============

// 1. 获取连接状态
server.tool(
  "get_connection_status",
  "获取浏览器扩展的连接状态",
  {},
  async () => {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          connected: browserState.connected,
          wsPort: WS_PORT,
          message: browserState.connected 
            ? "浏览器扩展已连接，可以开始使用其他工具"
            : "浏览器扩展未连接。请确保：\n1. Chrome扩展已加载\n2. 已在扩展设置中启用MCP连接\n3. 已打开目标网页"
        }, null, 2)
      }]
    };
  }
);

// 2. 获取当前页面信息
server.tool(
  "get_page_info",
  "获取当前浏览器页面的基本信息（URL、标题、域名等）",
  {},
  async () => {
    try {
      const pageInfo = await sendToBrowser("GET_PAGE_INFO");
      return {
        content: [{
          type: "text",
          text: JSON.stringify(pageInfo, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取页面信息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 3. 获取网络请求列表
server.tool(
  "get_network_requests",
  "获取页面的网络请求/API调用记录",
  {
    limit: z.number().optional().describe("返回的最大请求数量，默认50"),
    filter: z.string().optional().describe("URL过滤关键词"),
    method: z.string().optional().describe("HTTP方法过滤（GET, POST等）")
  },
  async ({ limit = 50, filter, method }) => {
    try {
      const requests = await sendToBrowser("GET_NETWORK_REQUESTS", { limit, filter, method });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(requests, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取网络请求失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 4. 获取Vue Router信息
server.tool(
  "get_vue_routes",
  "获取页面的Vue Router路由信息（需要先启用获取路由脚本）",
  {},
  async () => {
    try {
      const vueData = await sendToBrowser("GET_VUE_ROUTER_DATA");
      return {
        content: [{
          type: "text",
          text: JSON.stringify(vueData, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取Vue路由失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 5. 获取Hook捕获的数据
server.tool(
  "get_hook_data",
  "获取Hook脚本捕获的数据（cookie、localStorage、XHR等）",
  {
    scriptId: z.string().optional().describe("筛选特定Hook脚本的数据"),
    limit: z.number().optional().describe("返回的最大数据条数，默认50"),
    clear: z.boolean().optional().describe("获取后是否清空数据")
  },
  async ({ scriptId, limit = 50, clear = false }) => {
    try {
      const hookData = await sendToBrowser("GET_HOOK_DATA", { scriptId, limit, clear });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(hookData, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取Hook数据失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 6. 获取已启用的脚本列表
server.tool(
  "get_enabled_scripts",
  "获取当前页面已启用的脚本列表",
  {},
  async () => {
    try {
      const scripts = await sendToBrowser("GET_ENABLED_SCRIPTS");
      return {
        content: [{
          type: "text",
          text: JSON.stringify(scripts, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取脚本列表失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 7. 启用/禁用脚本
server.tool(
  "toggle_script",
  "启用或禁用指定的脚本",
  {
    scriptId: z.string().describe("脚本ID，如 'hook_xhr_open', 'Get_Vue_0' 等"),
    enabled: z.boolean().describe("是否启用")
  },
  async ({ scriptId, enabled }) => {
    try {
      const result = await sendToBrowser("TOGGLE_SCRIPT", { scriptId, enabled });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            scriptId,
            enabled,
            message: `脚本 ${scriptId} 已${enabled ? "启用" : "禁用"}，刷新页面后生效`
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `切换脚本失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 8. 导航到指定URL
server.tool(
  "navigate_to",
  "导航到指定的URL或Vue路由",
  {
    url: z.string().describe("目标URL或路由路径")
  },
  async ({ url }) => {
    try {
      const result = await sendToBrowser("NAVIGATE_TO", { url });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            url,
            message: `已导航到: ${url}`
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `导航失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 9. 获取Cookie
server.tool(
  "get_cookies",
  "获取当前页面的Cookie",
  {
    name: z.string().optional().describe("Cookie名称过滤")
  },
  async ({ name }) => {
    try {
      const cookies = await sendToBrowser("GET_COOKIES", { name });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(cookies, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取Cookie失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 10. 获取LocalStorage
server.tool(
  "get_local_storage",
  "获取当前页面的LocalStorage数据",
  {
    key: z.string().optional().describe("键名过滤")
  },
  async ({ key }) => {
    try {
      const storage = await sendToBrowser("GET_LOCAL_STORAGE", { key });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(storage, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取LocalStorage失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 11. 获取SessionStorage
server.tool(
  "get_session_storage",
  "获取当前页面的SessionStorage数据",
  {
    key: z.string().optional().describe("键名过滤")
  },
  async ({ key }) => {
    try {
      const storage = await sendToBrowser("GET_SESSION_STORAGE", { key });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(storage, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取SessionStorage失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 12. 执行JavaScript代码
server.tool(
  "execute_script",
  "在页面上下文中执行JavaScript代码",
  {
    code: z.string().describe("要执行的JavaScript代码"),
    world: z.enum(["MAIN", "ISOLATED"]).optional().describe("执行环境：MAIN(页面主世界)或ISOLATED(隔离环境)")
  },
  async ({ code, world = "MAIN" }) => {
    try {
      const result = await sendToBrowser("EXECUTE_SCRIPT", { code, world });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            result
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `执行脚本失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 13. 获取DOM元素信息
server.tool(
  "get_dom_info",
  "获取页面DOM结构信息",
  {
    selector: z.string().optional().describe("CSS选择器，不填则获取body"),
    depth: z.number().optional().describe("遍历深度，默认3")
  },
  async ({ selector = "body", depth = 3 }) => {
    try {
      const domInfo = await sendToBrowser("GET_DOM_INFO", { selector, depth });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(domInfo, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取DOM信息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 14. 配置Hook脚本参数
server.tool(
  "configure_hook",
  "配置Hook脚本的参数（如关键字过滤、debugger开关等）",
  {
    scriptId: z.string().describe("脚本ID"),
    config: z.object({
      keywords: z.array(z.string()).optional().describe("关键字过滤列表"),
      enableDebugger: z.boolean().optional().describe("是否启用debugger断点"),
      enableStack: z.boolean().optional().describe("是否打印调用堆栈"),
      fixedValue: z.string().optional().describe("固定返回值（用于Math.random等）")
    }).describe("配置选项")
  },
  async ({ scriptId, config }) => {
    try {
      const result = await sendToBrowser("CONFIGURE_HOOK", { scriptId, config });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            scriptId,
            config,
            message: "Hook配置已更新"
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `配置Hook失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 15. 获取可用脚本列表
server.tool(
  "list_available_scripts",
  "获取所有可用的脚本列表及其描述",
  {
    category: z.enum(["antidebug", "hook", "vue", "all"]).optional().describe("脚本分类")
  },
  async ({ category = "all" }) => {
    try {
      const scripts = await sendToBrowser("LIST_AVAILABLE_SCRIPTS", { category });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(scripts, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取脚本列表失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 16. 刷新页面
server.tool(
  "refresh_page",
  "刷新当前页面",
  {
    hardRefresh: z.boolean().optional().describe("是否强制刷新（清除缓存）")
  },
  async ({ hardRefresh = false }) => {
    try {
      await sendToBrowser("REFRESH_PAGE", { hardRefresh });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: hardRefresh ? "页面已强制刷新" : "页面已刷新"
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `刷新页面失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// ============== 新增：浏览器控制功能 ==============

// 17. 截图
server.tool(
  "take_screenshot",
  "截取当前页面的屏幕截图",
  {
    fullPage: z.boolean().optional().describe("是否截取整个页面"),
    selector: z.string().optional().describe("要截取的元素选择器")
  },
  async ({ fullPage = false, selector }) => {
    try {
      const result = await sendToBrowser("TAKE_SCREENSHOT", { fullPage, selector });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: "截图成功",
            dataUrl: result.dataUrl?.substring(0, 100) + "...[截断]",
            format: result.format
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `截图失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 18. 点击元素
server.tool(
  "click_element",
  "点击页面上的元素",
  {
    selector: z.string().optional().describe("CSS选择器"),
    x: z.number().optional().describe("X坐标"),
    y: z.number().optional().describe("Y坐标"),
    dblClick: z.boolean().optional().describe("是否双击")
  },
  async ({ selector, x, y, dblClick = false }) => {
    try {
      const result = await sendToBrowser("CLICK_ELEMENT", { selector, x, y, dblClick });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `点击失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 19. 填充输入框
server.tool(
  "fill_input",
  "在输入框中填充文本",
  {
    selector: z.string().describe("输入框的CSS选择器"),
    value: z.string().describe("要填充的值"),
    clear: z.boolean().optional().describe("是否先清空（默认true）")
  },
  async ({ selector, value, clear = true }) => {
    try {
      const result = await sendToBrowser("FILL_INPUT", { selector, value, clear });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `填充失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 20. 按键
server.tool(
  "press_key",
  "模拟按键操作",
  {
    key: z.string().describe("按键（如 Enter, Tab, Escape, ArrowDown 等）"),
    modifiers: z.array(z.enum(["Control", "Ctrl", "Shift", "Alt", "Meta", "Command"])).optional().describe("修饰键")
  },
  async ({ key, modifiers = [] }) => {
    try {
      const result = await sendToBrowser("PRESS_KEY", { key, modifiers });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `按键失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 21. 获取控制台消息
server.tool(
  "get_console_messages",
  "获取浏览器控制台消息",
  {
    limit: z.number().optional().describe("返回的最大消息数量"),
    types: z.array(z.enum(["log", "warn", "error", "info", "debug"])).optional().describe("消息类型过滤")
  },
  async ({ limit = 50, types = [] }) => {
    try {
      const messages = await sendToBrowser("GET_CONSOLE_MESSAGES", { limit, types });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(messages, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取控制台消息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 22. 滚动页面
server.tool(
  "scroll_page",
  "滚动页面到指定位置或元素",
  {
    x: z.number().optional().describe("水平滚动位置"),
    y: z.number().optional().describe("垂直滚动位置"),
    selector: z.string().optional().describe("滚动到指定元素"),
    behavior: z.enum(["smooth", "instant", "auto"]).optional().describe("滚动行为")
  },
  async ({ x = 0, y = 0, selector, behavior = "smooth" }) => {
    try {
      const result = await sendToBrowser("SCROLL_PAGE", { x, y, selector, behavior });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `滚动失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 23. 等待选择器
server.tool(
  "wait_for_selector",
  "等待页面上出现指定元素",
  {
    selector: z.string().describe("CSS选择器"),
    timeout: z.number().optional().describe("超时时间（毫秒），默认5000"),
    visible: z.boolean().optional().describe("是否要求元素可见")
  },
  async ({ selector, timeout = 5000, visible = true }) => {
    try {
      const result = await sendToBrowser("WAIT_FOR_SELECTOR", { selector, timeout, visible });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `等待失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 24. 获取元素信息
server.tool(
  "get_element_info",
  "获取页面元素的详细信息",
  {
    selector: z.string().describe("CSS选择器")
  },
  async ({ selector }) => {
    try {
      const info = await sendToBrowser("GET_ELEMENT_INFO", { selector });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(info, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取元素信息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 25. 准备路由访问（自动启用必要脚本）
server.tool(
  "prepare_route_access",
  "准备访问Vue路由（自动启用清除路由守卫和清除跳转脚本）",
  {},
  async () => {
    try {
      const result = await sendToBrowser("PREPARE_ROUTE_ACCESS", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `准备失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 26. 扫描路由收集API
server.tool(
  "scan_route_for_api",
  "访问指定路由并收集该路由触发的API请求",
  {
    route: z.string().describe("要访问的路由路径"),
    waitTime: z.number().optional().describe("等待API请求的时间（毫秒），默认3000")
  },
  async ({ route, waitTime = 3000 }) => {
    try {
      const result = await sendToBrowser("SCAN_ROUTE_FOR_API", { route, waitTime }, waitTime + 5000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `扫描路由失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 27. 批量扫描路由收集API
server.tool(
  "batch_scan_routes",
  "批量访问多个路由并收集所有API请求",
  {
    routes: z.array(z.string()).describe("要访问的路由路径列表"),
    waitTime: z.number().optional().describe("每个路由等待API请求的时间（毫秒），默认2000")
  },
  async ({ routes, waitTime = 2000 }) => {
    try {
      const allApis: any[] = [];
      const results: any[] = [];
      
      for (const route of routes) {
        try {
          const result = await sendToBrowser("SCAN_ROUTE_FOR_API", { route, waitTime }, waitTime + 5000);
          results.push(result);
          if (result.apiRequests) {
            allApis.push(...result.apiRequests.map((api: any) => ({
              ...api,
              route
            })));
          }
        } catch (e: any) {
          results.push({ route, error: e.message });
        }
      }
      
      // 去重
      const uniqueApis = allApis.filter((api, index, self) =>
        index === self.findIndex(a => a.url === api.url && a.method === api.method)
      );
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalRoutes: routes.length,
            totalApis: uniqueApis.length,
            apis: uniqueApis,
            routeResults: results
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `批量扫描失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// ============== 加密分析功能 ==============

// 28. 启用加密 Hook 脚本
server.tool(
  "enable_encryption_hooks",
  "启用 RSA 和 CryptoJS 加密 Hook 脚本，用于捕获加密数据",
  {},
  async () => {
    try {
      const result = await sendToBrowser("ENABLE_ENCRYPTION_HOOKS", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `启用加密Hook失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 29. 分析页面加密
server.tool(
  "analyze_page_encryption",
  "分析当前页面使用的加密库和密钥",
  {},
  async () => {
    try {
      const result = await sendToBrowser("ANALYZE_PAGE_ENCRYPTION", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `分析加密失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 30. 自动登录并捕获加密数据
server.tool(
  "auto_login_and_capture",
  "自动填写登录表单并捕获加密数据（密码加密前后的值）",
  {
    username: z.string().describe("用户名"),
    password: z.string().describe("密码"),
    usernameSelector: z.string().optional().describe("用户名输入框选择器"),
    passwordSelector: z.string().optional().describe("密码输入框选择器"),
    submitSelector: z.string().optional().describe("登录按钮选择器"),
    waitTime: z.number().optional().describe("等待时间(毫秒)")
  },
  async ({ username, password, usernameSelector, passwordSelector, submitSelector, waitTime = 3000 }) => {
    try {
      const result = await sendToBrowser("AUTO_LOGIN_AND_CAPTURE", {
        username, password, usernameSelector, passwordSelector, submitSelector, waitTime
      }, waitTime + 5000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `自动登录失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 31. 获取捕获的加密数据
server.tool(
  "get_captured_encryption",
  "获取 Hook 脚本捕获的加密数据（公钥、明文、密文等）",
  {},
  async () => {
    try {
      const result = await sendToBrowser("GET_CAPTURED_ENCRYPTION", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取加密数据失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 32. RSA 解密
server.tool(
  "decrypt_rsa",
  "使用私钥解密 RSA 加密的数据",
  {
    encryptedData: z.string().describe("Base64编码的加密数据"),
    privateKey: z.string().describe("RSA私钥")
  },
  async ({ encryptedData, privateKey }) => {
    try {
      const result = await sendToBrowser("DECRYPT_RSA", { encryptedData, privateKey });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `RSA解密失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 33. 从JS文件提取密钥
server.tool(
  "extract_keys_from_js",
  "从指定的JS文件中提取RSA公钥、私钥等加密信息",
  {
    jsUrl: z.string().describe("JS文件的URL")
  },
  async ({ jsUrl }) => {
    try {
      const result = await sendToBrowser("EXTRACT_KEYS_FROM_JS", { jsUrl }, 15000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `提取密钥失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 34. 一键分析登录加密（综合功能）
server.tool(
  "analyze_login_encryption",
  "一键分析登录页面的密码加密方式：启用Hook -> 自动登录 -> 捕获加密数据 -> 提取密钥 -> 尝试解密",
  {
    username: z.string().describe("测试用户名"),
    password: z.string().describe("测试密码")
  },
  async ({ username, password }) => {
    try {
      const results: any = { steps: [] };
      
      // 步骤1: 启用加密Hook
      results.steps.push({ step: 1, action: "启用加密Hook" });
      await sendToBrowser("ENABLE_ENCRYPTION_HOOKS", {});
      
      // 步骤2: 刷新页面
      results.steps.push({ step: 2, action: "刷新页面" });
      await sendToBrowser("REFRESH_PAGE", { hardRefresh: true });
      await new Promise(r => setTimeout(r, 2000));
      
      // 步骤3: 注入加密捕获器
      results.steps.push({ step: 3, action: "注入加密捕获器" });
      await sendToBrowser("INJECT_ENCRYPTION_CAPTURE", {});
      
      // 步骤4: 分析页面加密
      results.steps.push({ step: 4, action: "分析页面加密库" });
      results.pageAnalysis = await sendToBrowser("ANALYZE_PAGE_ENCRYPTION", {});
      
      // 步骤5: 自动登录
      results.steps.push({ step: 5, action: "自动登录并捕获" });
      results.loginResult = await sendToBrowser("AUTO_LOGIN_AND_CAPTURE", {
        username, password, waitTime: 3000
      }, 10000);
      
      // 步骤6: 获取捕获的加密数据
      results.steps.push({ step: 6, action: "获取加密数据" });
      results.encryptionData = await sendToBrowser("GET_CAPTURED_ENCRYPTION", {});
      
      // 分析结果
      results.summary = {
        encryptionMethod: results.pageAnalysis?.detectedEncryption || "未知",
        hasPublicKey: !!results.pageAnalysis?.keys?.publicKey,
        hasPrivateKey: !!results.pageAnalysis?.keys?.privateKey,
        capturedDataCount: results.encryptionData?.length || 0
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `分析失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：反调试 ==============

// 35. 检测反调试机制
server.tool(
  "detect_anti_debug",
  "检测页面中的反调试机制（debugger语句、控制台检测、窗口大小检测等）",
  {},
  async () => {
    try {
      const result = await sendToBrowser("DETECT_ANTI_DEBUG", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `检测失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 36. 自动绕过反调试
server.tool(
  "auto_bypass_anti_debug",
  "检测并自动启用相应的反调试绕过脚本",
  {},
  async () => {
    try {
      const result = await sendToBrowser("AUTO_BYPASS_ANTI_DEBUG", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `绕过失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：API分析 ==============

// 37. 分析API签名
server.tool(
  "analyze_api_signature",
  "分析最近的API请求，提取签名参数、加密参数等特征",
  {},
  async () => {
    try {
      const result = await sendToBrowser("ANALYZE_API_SIGNATURE", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `分析失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：框架数据提取 ==============

// 38. 提取Vue数据
server.tool(
  "extract_vue_data",
  "提取页面Vue组件的data、computed、methods等数据",
  {
    selector: z.string().optional().describe("目标元素选择器，默认为#app")
  },
  async ({ selector }) => {
    try {
      const result = await sendToBrowser("EXTRACT_VUE_DATA", { selector });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `提取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 39. 提取React数据
server.tool(
  "extract_react_data",
  "提取页面React组件的props、state等数据",
  {
    selector: z.string().optional().describe("目标元素选择器，默认为#root")
  },
  async ({ selector }) => {
    try {
      const result = await sendToBrowser("EXTRACT_REACT_DATA", { selector });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `提取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：认证分析 ==============

// 40. 分析认证机制
server.tool(
  "analyze_authentication",
  "分析页面的认证机制（Cookie、localStorage中的token、JWT解析等）",
  {},
  async () => {
    try {
      const result = await sendToBrowser("ANALYZE_AUTHENTICATION", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `分析失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：表单自动化 ==============

// 41. 获取页面表单
server.tool(
  "get_page_forms",
  "获取页面所有表单信息（输入框、按钮、选择器等）",
  {},
  async () => {
    try {
      const result = await sendToBrowser("GET_PAGE_FORMS", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 42. 自动填充表单
server.tool(
  "auto_fill_form",
  "自动填充指定表单的输入框",
  {
    formIndex: z.number().optional().describe("表单索引，默认0"),
    values: z.record(z.string()).describe("要填充的值，格式: {选择器: 值}")
  },
  async ({ formIndex = 0, values }) => {
    try {
      const result = await sendToBrowser("AUTO_FILL_FORM", { formIndex, values });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `填充失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：WebSocket监控 ==============

// 43. 注入WebSocket监控
server.tool(
  "inject_ws_monitor",
  "注入WebSocket监控，捕获所有WebSocket通信",
  {},
  async () => {
    try {
      const result = await sendToBrowser("INJECT_WS_MONITOR", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `注入失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 44. 获取WebSocket消息
server.tool(
  "get_ws_messages",
  "获取捕获的WebSocket消息",
  {
    limit: z.number().optional().describe("返回的最大消息数，默认50")
  },
  async ({ limit = 50 }) => {
    try {
      const result = await sendToBrowser("GET_WS_MESSAGES", { limit });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：数据爬取 ==============

// 45. 提取页面数据
server.tool(
  "extract_page_data",
  "根据选择器提取页面结构化数据",
  {
    selectors: z.record(z.string()).describe("选择器映射，格式: {名称: CSS选择器}")
  },
  async ({ selectors }) => {
    try {
      const result = await sendToBrowser("EXTRACT_PAGE_DATA", { selectors });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `提取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 46. 提取表格数据
server.tool(
  "extract_table_data",
  "提取页面表格数据为结构化格式",
  {
    selector: z.string().optional().describe("表格选择器，默认为第一个table")
  },
  async ({ selector }) => {
    try {
      const result = await sendToBrowser("EXTRACT_TABLE_DATA", { selector });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `提取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 综合功能：一键分析页面 ==============

// 47. 一键分析页面
server.tool(
  "full_page_analysis",
  "一键全面分析页面：反调试检测、框架识别、加密分析、认证分析、表单识别",
  {},
  async () => {
    try {
      const results: any = { timestamp: Date.now() };
      
      // 1. 基本信息
      results.pageInfo = await sendToBrowser("GET_PAGE_INFO", {});
      
      // 2. 反调试检测
      try {
        results.antiDebug = await sendToBrowser("DETECT_ANTI_DEBUG", {});
      } catch (e) { results.antiDebug = { error: 'failed' }; }
      
      // 3. 加密分析
      try {
        results.encryption = await sendToBrowser("ANALYZE_PAGE_ENCRYPTION", {});
      } catch (e) { results.encryption = { error: 'failed' }; }
      
      // 4. 认证分析
      try {
        results.authentication = await sendToBrowser("ANALYZE_AUTHENTICATION", {});
      } catch (e) { results.authentication = { error: 'failed' }; }
      
      // 5. 表单分析
      try {
        results.forms = await sendToBrowser("GET_PAGE_FORMS", {});
      } catch (e) { results.forms = { error: 'failed' }; }
      
      // 6. Vue/React 检测
      try {
        results.vue = await sendToBrowser("EXTRACT_VUE_DATA", {});
      } catch (e) {}
      try {
        results.react = await sendToBrowser("EXTRACT_REACT_DATA", {});
      } catch (e) {}
      
      // 生成摘要
      results.summary = {
        url: results.pageInfo?.url,
        title: results.pageInfo?.title,
        hasAntiDebug: results.antiDebug?.hasDebugger || results.antiDebug?.hasDevtoolsCheck,
        framework: results.vue?.version || results.react?.version || 'Unknown',
        encryptionMethod: results.encryption?.detectedEncryption || 'Unknown',
        hasAuthTokens: (results.authentication?.cookies?.authRelated?.length || 0) + 
                       (results.authentication?.localStorage?.authRelated?.length || 0) > 0,
        formCount: Array.isArray(results.forms) ? results.forms.length : 0
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `分析失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== Burp Suite 格式网络请求 ==============

// 48. 点击元素并捕获请求
server.tool(
  "click_and_capture",
  "点击指定元素并捕获产生的所有网络请求（包含请求头、响应头、响应体）",
  {
    selector: z.string().describe("要点击的元素CSS选择器"),
    waitTime: z.number().optional().describe("等待请求完成的时间(毫秒)，默认3000")
  },
  async ({ selector, waitTime = 3000 }) => {
    try {
      const result = await sendToBrowser("CLICK_AND_CAPTURE", { selector, waitTime }, waitTime + 5000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `点击捕获失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 49. 获取 Burp 格式网络请求
server.tool(
  "get_network_requests_burp",
  "获取网络请求并转换为Burp Suite格式（包含完整的HTTP请求和响应）",
  {
    filter: z.string().optional().describe("URL过滤关键词"),
    limit: z.number().optional().describe("返回的最大数量，默认50")
  },
  async ({ filter, limit = 50 }) => {
    try {
      const result = await sendToBrowser("GET_NETWORK_REQUESTS_BURP", { filter, limit });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 50. 点击并获取 Burp 格式请求
server.tool(
  "click_and_get_burp",
  "点击元素（如登录按钮）并获取产生的网络请求，输出Burp Suite格式",
  {
    selector: z.string().describe("要点击的元素CSS选择器（如登录按钮）"),
    waitTime: z.number().optional().describe("等待请求完成的时间(毫秒)，默认3000")
  },
  async ({ selector, waitTime = 3000 }) => {
    try {
      const result = await sendToBrowser("CLICK_AND_GET_BURP", { selector, waitTime }, waitTime + 5000);
      
      // 格式化输出
      let output = `## 点击元素: ${selector}\n\n`;
      output += `### 捕获到 ${result.totalRequests || 0} 个请求\n\n`;
      
      if (result.burpRequests && result.burpRequests.length > 0) {
        for (const req of result.burpRequests) {
          output += `---\n`;
          output += `#### [${req.index}] ${req.method} ${req.path}\n`;
          output += `**Host:** ${req.host}:${req.port} (${req.protocol})\n`;
          output += `**Status:** ${req.status || 'Pending'} | **Duration:** ${req.duration}\n\n`;
          
          output += `**📤 Request:**\n\`\`\`http\n${req.request}\`\`\`\n\n`;
          
          if (req.response) {
            output += `**📥 Response:**\n\`\`\`http\n${req.response.substring(0, 2000)}${req.response.length > 2000 ? '\n...(truncated)' : ''}\`\`\`\n\n`;
          }
        }
      } else {
        output += `*未捕获到请求*\n`;
      }
      
      return {
        content: [{
          type: "text",
          text: output
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `点击捕获失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 51. 自动登录并获取 Burp 格式请求
server.tool(
  "login_and_get_burp",
  "自动填写登录表单、点击登录按钮，并获取登录请求的Burp格式数据包",
  {
    username: z.string().describe("用户名"),
    password: z.string().describe("密码"),
    usernameSelector: z.string().optional().describe("用户名输入框选择器"),
    passwordSelector: z.string().optional().describe("密码输入框选择器"),
    submitSelector: z.string().optional().describe("登录按钮选择器"),
    waitTime: z.number().optional().describe("等待时间(毫秒)")
  },
  async ({ username, password, usernameSelector, passwordSelector, submitSelector, waitTime = 3000 }) => {
    try {
      // 使用客户端的 LOGIN_AND_GET_BURP 命令
      const result = await sendToBrowser("LOGIN_AND_GET_BURP", {
        username, password, usernameSelector, passwordSelector, submitSelector, waitTime
      }, waitTime + 10000);
      
      // 格式化 Burp 输出
      if (result.burpRequests && result.burpRequests.length > 0) {
        let output = "## 自动登录并捕获请求\n\n";
        output += "**用户名:** " + username + "\n";
        output += "**密码:** " + password + "\n\n";
        output += "### 捕获到 " + result.burpRequests.length + " 个请求\n\n";
        
        for (const req of result.burpRequests) {
          output += "---\n";
          output += "#### [" + req.index + "] " + req.method + " " + req.path + "\n";
          output += "**Host:** " + req.host + ":" + req.port + " (" + req.protocol + ")\n";
          output += "**Status:** " + (req.status || "Pending") + " | **Duration:** " + req.duration + "\n\n";
          output += "**Request:**\n```http\n" + req.request + "```\n\n";
          if (req.response) {
            const respText = req.response.length > 2000 ? req.response.substring(0, 2000) + "\n...(truncated)" : req.response;
            output += "**Response:**\n```http\n" + respText + "```\n\n";
          }
        }
        
        return {
          content: [{ type: "text", text: output }]
        };
      }
      
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: "登录捕获失败: " + error.message }],
        isError: true
      };
    }
  }
);

// ============== 敏感数据泄露检测功能 ==============

// 敏感数据正则表达式定义
const SENSITIVE_PATTERNS = {
  // 身份证号（18位/15位）
  idCard: {
    pattern: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b|\b[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}\b/g,
    severity: "critical",
    description: "身份证号"
  },
  // 手机号
  phone: {
    pattern: /\b1[3-9]\d{9}\b/g,
    severity: "high", 
    description: "手机号"
  },
  // 银行卡号（16-19位）
  bankCard: {
    pattern: /\b(?:62|4[0-9]|5[1-5]|6[2-6])\d{14,17}\b/g,
    severity: "critical",
    description: "银行卡号"
  },
  // 邮箱
  email: {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    severity: "medium",
    description: "邮箱地址"
  },
  // 中文姓名（2-4个汉字）
  chineseName: {
    pattern: /[\u4e00-\u9fa5]{2,4}/g,
    severity: "low",
    description: "中文姓名(疑似)"
  },
  // 密码字段
  password: {
    pattern: /"(?:password|passwd|pwd|pass|secret|token|key)"\s*:\s*"[^"]+"/gi,
    severity: "critical",
    description: "密码/密钥字段"
  },
  // IP地址
  ipAddress: {
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    severity: "low",
    description: "IP地址"
  },
  // JWT Token
  jwt: {
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    severity: "high",
    description: "JWT Token"
  },
  // 社保号/公积金号
  socialSecurity: {
    pattern: /\b[A-Z]{1}\d{7,9}\b/g,
    severity: "high",
    description: "社保/公积金号(疑似)"
  }
};

// 敏感数据分析函数
function analyzeSensitiveData(text: string, enabledPatterns: string[] = []): {
  hasSensitiveData: boolean;
  severity: string;
  findings: Array<{
    type: string;
    description: string;
    severity: string;
    matches: string[];
    count: number;
  }>;
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
} {
  const findings: Array<{
    type: string;
    description: string;
    severity: string;
    matches: string[];
    count: number;
  }> = [];
  
  const summary = { critical: 0, high: 0, medium: 0, low: 0 };
  
  // 默认检测高风险字段
  const patternsToCheck = enabledPatterns.length > 0 
    ? enabledPatterns 
    : ['idCard', 'phone', 'bankCard', 'password', 'jwt'];
  
  for (const [key, config] of Object.entries(SENSITIVE_PATTERNS)) {
    if (patternsToCheck.includes(key) || patternsToCheck.includes('all')) {
      const matches = text.match(config.pattern);
      if (matches && matches.length > 0) {
        // 去重并限制数量
        const uniqueMatches = [...new Set(matches)].slice(0, 10);
        
        // 对于中文姓名，需要额外过滤（排除常见词汇）
        if (key === 'chineseName') {
          const filtered = uniqueMatches.filter(m => 
            !['用户名', '密码', '登录', '注册', '确认', '取消', '提交', '返回', '首页', '管理'].includes(m)
          );
          if (filtered.length === 0) continue;
        }
        
        findings.push({
          type: key,
          description: config.description,
          severity: config.severity,
          matches: uniqueMatches.map(m => maskSensitiveData(m, key)),
          count: matches.length
        });
        
        summary[config.severity as keyof typeof summary]++;
      }
    }
  }
  
  // 确定最高严重级别
  let maxSeverity = 'none';
  if (summary.critical > 0) maxSeverity = 'critical';
  else if (summary.high > 0) maxSeverity = 'high';
  else if (summary.medium > 0) maxSeverity = 'medium';
  else if (summary.low > 0) maxSeverity = 'low';
  
  return {
    hasSensitiveData: findings.length > 0,
    severity: maxSeverity,
    findings,
    summary
  };
}

// 敏感数据脱敏函数
function maskSensitiveData(data: string, type: string): string {
  switch (type) {
    case 'idCard':
      return data.slice(0, 6) + '****' + data.slice(-4);
    case 'phone':
      return data.slice(0, 3) + '****' + data.slice(-4);
    case 'bankCard':
      return data.slice(0, 4) + '****' + data.slice(-4);
    case 'email':
      const [local, domain] = data.split('@');
      return local.slice(0, 2) + '***@' + domain;
    case 'password':
      return data.replace(/"[^"]+"/g, '"***"');
    default:
      return data;
  }
}

// 52. 扫描 API 响应敏感数据
server.tool(
  "scan_sensitive_data",
  "扫描最近的API响应中是否包含敏感数据（身份证、手机号、银行卡、密码等）",
  {
    filter: z.string().optional().describe("URL过滤关键词"),
    patterns: z.array(z.enum(['idCard', 'phone', 'bankCard', 'email', 'chineseName', 'password', 'ipAddress', 'jwt', 'socialSecurity', 'all']))
      .optional()
      .describe("要检测的敏感数据类型，默认检测高风险类型"),
    limit: z.number().optional().describe("扫描的最大请求数量，默认20")
  },
  async ({ filter, patterns = ['idCard', 'phone', 'bankCard', 'password', 'jwt'], limit = 20 }) => {
    try {
      // 获取网络请求（包含响应体）
      const requests = await sendToBrowser("GET_NETWORK_REQUESTS_WITH_BODY", { filter, limit });
      
      const results: Array<{
        url: string;
        method: string;
        status: number;
        sensitiveData: ReturnType<typeof analyzeSensitiveData>;
        alertLevel: string;
      }> = [];
      
      let totalCritical = 0;
      let totalHigh = 0;
      
      for (const req of requests) {
        // 分析响应体
        const responseBody = req.responseBody || '';
        const analysis = analyzeSensitiveData(responseBody, patterns);
        
        if (analysis.hasSensitiveData) {
          results.push({
            url: req.url,
            method: req.method,
            status: req.statusCode,
            sensitiveData: analysis,
            alertLevel: analysis.severity
          });
          
          totalCritical += analysis.summary.critical;
          totalHigh += analysis.summary.high;
        }
      }
      
      // 生成报告
      const report = {
        scanTime: new Date().toISOString(),
        totalScanned: requests.length,
        issuesFound: results.length,
        severity: {
          critical: totalCritical,
          high: totalHigh
        },
        alert: totalCritical > 0 ? "🚨 严重警告：发现敏感数据泄露！" : 
               totalHigh > 0 ? "⚠️ 警告：发现潜在敏感数据" : 
               "✅ 未发现敏感数据泄露",
        findings: results
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(report, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `扫描失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 53. 扫描路由敏感数据泄露
server.tool(
  "scan_route_sensitive_data",
  "访问指定路由并扫描返回数据中的敏感信息泄露",
  {
    route: z.string().describe("要访问的路由路径或完整URL"),
    waitTime: z.number().optional().describe("等待API请求的时间（毫秒），默认3000"),
    patterns: z.array(z.string()).optional().describe("要检测的敏感数据类型")
  },
  async ({ route, waitTime = 3000, patterns = ['idCard', 'phone', 'bankCard', 'password', 'jwt'] }) => {
    try {
      // 导航到目标路由
      await sendToBrowser("NAVIGATE_TO", { url: route });
      
      // 等待页面加载和API请求
      await new Promise(r => setTimeout(r, waitTime));
      
      // 获取页面信息
      const pageInfo = await sendToBrowser("GET_PAGE_INFO", {});
      
      // 获取页面内容
      const pageContent = await sendToBrowser("GET_PAGE_CONTENT", {});
      
      // 获取网络请求
      const requests = await sendToBrowser("GET_NETWORK_REQUESTS_WITH_BODY", { limit: 50 });
      
      // 分析页面内容
      const pageAnalysis = analyzeSensitiveData(pageContent || '', patterns);
      
      // 分析API响应
      const apiFindings: Array<{
        url: string;
        method: string;
        analysis: ReturnType<typeof analyzeSensitiveData>;
      }> = [];
      
      for (const req of requests) {
        if (req.responseBody) {
          const analysis = analyzeSensitiveData(req.responseBody, patterns);
          if (analysis.hasSensitiveData) {
            apiFindings.push({
              url: req.url,
              method: req.method,
              analysis
            });
          }
        }
      }
      
      // 计算总体风险
      const hasCritical = pageAnalysis.summary.critical > 0 || 
                         apiFindings.some(f => f.analysis.summary.critical > 0);
      const hasHigh = pageAnalysis.summary.high > 0 || 
                      apiFindings.some(f => f.analysis.summary.high > 0);
      
      const report = {
        route,
        pageUrl: pageInfo?.url,
        pageTitle: pageInfo?.title,
        scanTime: new Date().toISOString(),
        riskLevel: hasCritical ? "🚨 严重" : hasHigh ? "⚠️ 高危" : "✅ 安全",
        pageContentAnalysis: pageAnalysis,
        apiResponsesAnalysis: {
          totalApis: requests.length,
          apisWithSensitiveData: apiFindings.length,
          findings: apiFindings
        },
        recommendation: hasCritical 
          ? "立即修复！页面或API存在严重敏感数据泄露，包含身份证、银行卡或密码信息。"
          : hasHigh
          ? "建议修复！发现手机号或其他敏感信息泄露。"
          : "该路由暂未发现明显敏感数据泄露。"
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(report, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `扫描失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 54. 批量扫描多个路由的敏感数据
server.tool(
  "batch_scan_sensitive_routes",
  "批量扫描多个路由，检测敏感数据泄露（适用于大屏、后台等未授权访问测试）",
  {
    routes: z.array(z.string()).describe("要扫描的路由列表"),
    waitTime: z.number().optional().describe("每个路由等待时间（毫秒），默认2000"),
    patterns: z.array(z.string()).optional().describe("要检测的敏感数据类型")
  },
  async ({ routes, waitTime = 2000, patterns = ['idCard', 'phone', 'bankCard', 'password', 'jwt'] }) => {
    try {
      const results: Array<{
        route: string;
        riskLevel: string;
        critical: number;
        high: number;
        findings: string[];
      }> = [];
      
      let totalCritical = 0;
      let totalHigh = 0;
      
      for (const route of routes) {
        try {
          // 导航
          await sendToBrowser("NAVIGATE_TO", { url: route });
          await new Promise(r => setTimeout(r, waitTime));
          
          // 获取页面内容
          const pageContent = await sendToBrowser("GET_PAGE_CONTENT", {});
          
          // 获取API响应
          const requests = await sendToBrowser("GET_NETWORK_REQUESTS_WITH_BODY", { limit: 30 });
          
          // 合并分析
          let allContent = pageContent || '';
          for (const req of requests) {
            if (req.responseBody) {
              allContent += '\n' + req.responseBody;
            }
          }
          
          const analysis = analyzeSensitiveData(allContent, patterns);
          
          if (analysis.hasSensitiveData) {
            results.push({
              route,
              riskLevel: analysis.severity,
              critical: analysis.summary.critical,
              high: analysis.summary.high,
              findings: analysis.findings.map(f => `${f.description}: ${f.count}处`)
            });
            
            totalCritical += analysis.summary.critical;
            totalHigh += analysis.summary.high;
          }
        } catch (e: any) {
          results.push({
            route,
            riskLevel: 'error',
            critical: 0,
            high: 0,
            findings: [`扫描出错: ${e.message}`]
          });
        }
      }
      
      // 按风险排序
      results.sort((a, b) => {
        const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, error: 4 };
        return (severityOrder[a.riskLevel] || 5) - (severityOrder[b.riskLevel] || 5);
      });
      
      const report = {
        scanTime: new Date().toISOString(),
        totalRoutes: routes.length,
        routesWithIssues: results.filter(r => r.riskLevel !== 'error' && r.critical + r.high > 0).length,
        overallRisk: totalCritical > 0 ? "🚨 严重 - 存在敏感数据泄露！" :
                     totalHigh > 0 ? "⚠️ 高危 - 存在潜在数据泄露" :
                     "✅ 安全 - 未发现敏感数据泄露",
        summary: {
          criticalFindings: totalCritical,
          highFindings: totalHigh
        },
        details: results,
        recommendation: totalCritical > 0 
          ? "🔴 紧急！发现严重敏感数据泄露（身份证/银行卡/密码），请立即修复访问控制！"
          : totalHigh > 0
          ? "🟡 警告！发现敏感信息泄露（手机号等），建议添加访问权限控制。"
          : "🟢 扫描完成，未发现明显敏感数据泄露。"
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(report, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `批量扫描失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 55. 实时监控敏感数据（开启监控模式）
server.tool(
  "start_sensitive_monitor",
  "开始实时监控所有API响应中的敏感数据泄露",
  {
    patterns: z.array(z.string()).optional().describe("要监控的敏感数据类型"),
    alertOnCritical: z.boolean().optional().describe("发现严重泄露时是否立即告警，默认true")
  },
  async ({ patterns = ['idCard', 'phone', 'bankCard', 'password'], alertOnCritical = true }) => {
    try {
      const result = await sendToBrowser("START_SENSITIVE_MONITOR", { patterns, alertOnCritical });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: "敏感数据监控已启动",
            monitoringPatterns: patterns,
            alertOnCritical,
            ...result
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `启动监控失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 56. 获取敏感数据监控告警
server.tool(
  "get_sensitive_alerts",
  "获取敏感数据监控产生的告警信息",
  {
    limit: z.number().optional().describe("返回的最大告警数量，默认50"),
    severityFilter: z.enum(['critical', 'high', 'medium', 'low', 'all']).optional().describe("严重级别过滤")
  },
  async ({ limit = 50, severityFilter = 'all' }) => {
    try {
      const result = await sendToBrowser("GET_SENSITIVE_ALERTS", { limit, severityFilter });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取告警失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 资源定义 ==============

// 提供当前浏览器状态作为资源
server.resource(
  "browser-state",
  "browser://state",
  async (uri) => {
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(browserState, null, 2)
      }]
    };
  }
);

// ============== 启动服务器 ==============
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] AntiDebug Breaker MCP服务器已启动");
  console.error("[MCP] 等待浏览器扩展连接到 ws://localhost:" + WS_PORT);
}

main().catch((error) => {
  console.error("[MCP] 启动失败:", error);
  process.exit(1);
});
