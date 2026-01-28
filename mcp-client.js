/**
 * MCP Client - Chrome扩展与MCP服务器通信模块
 * 
 * 这个模块负责：
 * 1. 连接到MCP服务器的WebSocket
 * 2. 处理来自MCP的命令
 * 3. 收集页面数据并发送给MCP
 */

// ============== 配置 ==============
const MCP_DEFAULT_PORT = 9527;
const RECONNECT_INTERVAL = 5000; // 重连间隔（毫秒）
const MAX_RECONNECT_ATTEMPTS = 10;

// ============== 状态 ==============
let ws = null;
let isConnected = false;
let reconnectAttempts = 0;
let mcpEnabled = false;
let mcpPort = MCP_DEFAULT_PORT; // 当前使用的端口
let networkRequests = []; // 存储网络请求
let hookDataBuffer = []; // 存储Hook捕获的数据
let heartbeatInterval = null; // 心跳定时器
let lastPongTime = 0; // 最后收到 pong 的时间
const HEARTBEAT_INTERVAL = 5000; // 心跳间隔 5 秒
const HEARTBEAT_TIMEOUT = 10000; // 心跳超时 10 秒

// 获取当前MCP WebSocket URL
function getMCPWsUrl() {
    return `ws://localhost:${mcpPort}`;
}

// ============== WebSocket 连接管理 ==============

// 初始化MCP连接
function initMCPConnection() {
    // 检查是否启用了MCP，并获取端口配置
    chrome.storage.local.get(['mcp_enabled', 'mcp_port'], (result) => {
        mcpEnabled = result.mcp_enabled === true;
        mcpPort = result.mcp_port || MCP_DEFAULT_PORT;
        
        console.log('[MCP Client] 配置端口:', mcpPort);
        
        if (mcpEnabled) {
            connectToMCP();
        }
    });
}

// 连接到MCP服务器
function connectToMCP() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
    }

    const wsUrl = getMCPWsUrl();
    console.log('[MCP Client] 正在连接到MCP服务器:', wsUrl);
    
    try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('[MCP Client] 已连接到MCP服务器');
            isConnected = true;
            reconnectAttempts = 0;
            lastPongTime = Date.now();
            
            // 启动心跳检测
            startHeartbeat();
            
            // 发送初始页面信息
            sendCurrentPageInfo();
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                // 处理心跳响应
                if (message.type === 'PONG') {
                    lastPongTime = Date.now();
                    return;
                }
                handleMCPMessage(message);
            } catch (e) {
                console.error('[MCP Client] 解析消息失败:', e);
            }
        };

        ws.onclose = () => {
            console.log('[MCP Client] 与MCP服务器断开连接');
            handleDisconnect();
            
            // 尝试重连
            if (mcpEnabled && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                console.log(`[MCP Client] ${RECONNECT_INTERVAL/1000}秒后重连 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                setTimeout(connectToMCP, RECONNECT_INTERVAL);
            }
        };

        ws.onerror = (error) => {
            console.error('[MCP Client] WebSocket错误:', error);
            // 触发断开处理
            handleDisconnect();
        };
    } catch (e) {
        console.error('[MCP Client] 创建WebSocket失败:', e);
        handleDisconnect();
    }
}

// 处理断开连接
function handleDisconnect() {
    isConnected = false;
    ws = null;
    stopHeartbeat();
}

// 启动心跳检测
function startHeartbeat() {
    stopHeartbeat(); // 先清除旧的
    
    heartbeatInterval = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.log('[MCP Client] 心跳检测：连接已断开');
            handleDisconnect();
            return;
        }
        
        // 检查上次 pong 时间，如果超时则认为断开
        if (Date.now() - lastPongTime > HEARTBEAT_TIMEOUT) {
            console.log('[MCP Client] 心跳超时，连接可能已断开');
            handleDisconnect();
            // 尝试重连
            if (mcpEnabled && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                setTimeout(connectToMCP, RECONNECT_INTERVAL);
            }
            return;
        }
        
        // 发送心跳
        try {
            ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
        } catch (e) {
            console.error('[MCP Client] 发送心跳失败:', e);
            handleDisconnect();
        }
    }, HEARTBEAT_INTERVAL);
}

// 停止心跳检测
function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// 断开MCP连接
function disconnectFromMCP() {
    stopHeartbeat();
    if (ws) {
        ws.close();
        ws = null;
    }
    isConnected = false;
    reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // 阻止重连
}

// 发送消息到MCP服务器
function sendToMCP(type, data, requestId = null) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[MCP Client] 未连接到MCP服务器');
        return false;
    }

    try {
        ws.send(JSON.stringify({
            type,
            requestId,
            data
        }));
        return true;
    } catch (e) {
        console.error('[MCP Client] 发送消息失败:', e);
        return false;
    }
}

// 发送响应
function sendResponse(requestId, data, error = null) {
    sendToMCP('RESPONSE', data, requestId);
    if (error) {
        ws.send(JSON.stringify({
            requestId,
            error: error.message || error
        }));
    } else {
        ws.send(JSON.stringify({
            requestId,
            data
        }));
    }
}

// ============== 处理MCP命令 ==============

async function handleMCPMessage(message) {
    const { type, requestId, data } = message;
    
    try {
        let result;
        
        switch (type) {
            case 'GET_PAGE_INFO':
                result = await getPageInfo();
                break;
                
            case 'GET_NETWORK_REQUESTS':
                result = await getNetworkRequests(data);
                break;
                
            case 'GET_VUE_ROUTER_DATA':
                result = await getVueRouterData();
                break;
                
            case 'GET_HOOK_DATA':
                result = await getHookData(data);
                break;
                
            case 'GET_ENABLED_SCRIPTS':
                result = await getEnabledScripts();
                break;
                
            case 'TOGGLE_SCRIPT':
                result = await toggleScript(data);
                break;
                
            case 'NAVIGATE_TO':
                result = await navigateTo(data);
                break;
                
            case 'GET_COOKIES':
                result = await getCookies(data);
                break;
                
            case 'GET_LOCAL_STORAGE':
                result = await getLocalStorage(data);
                break;
                
            case 'GET_SESSION_STORAGE':
                result = await getSessionStorage(data);
                break;
                
            case 'EXECUTE_SCRIPT':
                result = await executeScript(data);
                break;
                
            case 'GET_DOM_INFO':
                result = await getDOMInfo(data);
                break;
                
            case 'CONFIGURE_HOOK':
                result = await configureHook(data);
                break;
                
            case 'LIST_AVAILABLE_SCRIPTS':
                result = await listAvailableScripts(data);
                break;
                
            case 'REFRESH_PAGE':
                result = await refreshPage(data);
                break;
            
            // ===== 新增：浏览器控制功能 =====
            case 'TAKE_SCREENSHOT':
                result = await takeScreenshot(data);
                break;
                
            case 'CLICK_ELEMENT':
                result = await clickElement(data);
                break;
                
            case 'FILL_INPUT':
                result = await fillInput(data);
                break;
                
            case 'PRESS_KEY':
                result = await pressKey(data);
                break;
                
            case 'GET_CONSOLE_MESSAGES':
                result = await getConsoleMessages(data);
                break;
                
            case 'SCROLL_PAGE':
                result = await scrollPage(data);
                break;
                
            case 'WAIT_FOR_SELECTOR':
                result = await waitForSelector(data);
                break;
                
            case 'GET_ELEMENT_INFO':
                result = await getElementInfo(data);
                break;
                
            case 'PREPARE_ROUTE_ACCESS':
                result = await prepareRouteAccess();
                break;
                
            case 'SCAN_ROUTE_FOR_API':
                result = await scanRouteForAPI(data);
                break;
            
            // ===== 新增：加密分析命令 =====
            case 'ENABLE_ENCRYPTION_HOOKS':
                result = await enableEncryptionHooks();
                break;
                
            case 'INJECT_ENCRYPTION_CAPTURE':
                result = await injectEncryptionCapture();
                break;
                
            case 'GET_CAPTURED_ENCRYPTION':
                result = await getCapturedEncryption();
                break;
                
            case 'ANALYZE_PAGE_ENCRYPTION':
                result = await analyzePageEncryption();
                break;
                
            case 'AUTO_LOGIN_AND_CAPTURE':
                result = await autoLoginAndCapture(data);
                break;
                
            case 'DECRYPT_RSA':
                result = await decryptRSA(data);
                break;
                
            case 'EXTRACT_KEYS_FROM_JS':
                result = await extractKeysFromJS(data);
                break;
            
            // ===== 智能化功能命令 =====
            case 'DETECT_ANTI_DEBUG':
                result = await detectAntiDebug();
                break;
                
            case 'AUTO_BYPASS_ANTI_DEBUG':
                result = await autoBypassAntiDebug();
                break;
                
            case 'ANALYZE_API_SIGNATURE':
                result = await analyzeAPISignature();
                break;
                
            case 'EXTRACT_VUE_DATA':
                result = await extractVueData(data);
                break;
                
            case 'EXTRACT_REACT_DATA':
                result = await extractReactData(data);
                break;
                
            case 'ANALYZE_AUTHENTICATION':
                result = await analyzeAuthentication();
                break;
                
            case 'GET_PAGE_FORMS':
                result = await getPageForms();
                break;
                
            case 'AUTO_FILL_FORM':
                result = await autoFillForm(data);
                break;
                
            case 'INJECT_WS_MONITOR':
                result = await injectWSMonitor();
                break;
                
            case 'GET_WS_MESSAGES':
                result = await getWSMessages(data);
                break;
                
            case 'EXTRACT_PAGE_DATA':
                result = await extractPageData(data);
                break;
                
            case 'EXTRACT_TABLE_DATA':
                result = await extractTableData(data);
                break;
            
            // ===== Burp 格式请求 =====
            case 'CLICK_AND_CAPTURE':
                result = await clickAndCapture(data);
                break;
                
            case 'GET_NETWORK_REQUESTS_BURP':
                result = await getNetworkRequestsBurp(data);
                break;
                
            case 'CLICK_AND_GET_BURP':
                result = await clickAndGetBurp(data);
                break;
                
            case 'LOGIN_AND_GET_BURP':
                result = await loginAndGetBurp(data);
                break;
            
            // ===== 敏感数据检测功能 =====
            case 'GET_NETWORK_REQUESTS_WITH_BODY':
                result = await getNetworkRequestsWithBody(data);
                break;
                
            case 'GET_PAGE_CONTENT':
                result = await getPageContent();
                break;
                
            case 'START_SENSITIVE_MONITOR':
                result = await startSensitiveMonitor(data);
                break;
                
            case 'GET_SENSITIVE_ALERTS':
                result = await getSensitiveAlerts(data);
                break;
            
            // ===== 请求头管理功能 =====
            case 'GET_HEADERS_CONFIG':
                result = await getHeadersConfig();
                break;
                
            case 'CREATE_HEADER_GROUP':
                result = await createHeaderGroup(data);
                break;
                
            case 'DELETE_HEADER_GROUP':
                result = await deleteHeaderGroup(data);
                break;
                
            case 'SWITCH_HEADER_GROUP':
                result = await switchHeaderGroup(data);
                break;
                
            case 'ADD_HEADER':
                result = await addHeader(data);
                break;
                
            case 'UPDATE_HEADER':
                result = await updateHeader(data);
                break;
                
            case 'DELETE_HEADER':
                result = await deleteHeader(data);
                break;
                
            case 'TOGGLE_HEADER':
                result = await toggleHeader(data);
                break;
                
            case 'BATCH_UPDATE_HEADERS':
                result = await batchUpdateHeaders(data);
                break;
            
            // ===== 智能场景协调功能 =====
            case 'BATCH_ENABLE_SCRIPTS':
                result = await batchEnableScripts(data);
                break;
                
            case 'DISABLE_ALL_SCRIPTS':
                result = await disableAllScripts(data);
                break;
                
            default:
                throw new Error(`未知命令: ${type}`);
        }
        
        sendResponse(requestId, result);
    } catch (error) {
        console.error('[MCP Client] 处理命令失败:', error);
        sendResponse(requestId, null, error);
    }
}

// ============== 命令实现 ==============

// 获取当前活动标签页
async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
}

// 获取页面信息
async function getPageInfo() {
    const tab = await getActiveTab();
    if (!tab || !tab.url) {
        throw new Error('无法获取当前标签页');
    }
    
    try {
        const url = new URL(tab.url);
        return {
            url: tab.url,
            title: tab.title,
            hostname: url.hostname,
            protocol: url.protocol,
            pathname: url.pathname,
            search: url.search,
            hash: url.hash,
            tabId: tab.id
        };
    } catch (e) {
        return {
            url: tab.url,
            title: tab.title,
            tabId: tab.id
        };
    }
}

// 获取网络请求
async function getNetworkRequests({ limit = 50, filter, method } = {}) {
    let requests = [...networkRequests];
    
    if (filter) {
        requests = requests.filter(r => r.url.includes(filter));
    }
    
    if (method) {
        requests = requests.filter(r => r.method.toUpperCase() === method.toUpperCase());
    }
    
    return requests.slice(-limit);
}

// 获取Vue Router数据
async function getVueRouterData() {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    const hostname = new URL(tab.url).hostname;
    
    // 从storage获取已存储的Vue数据
    return new Promise((resolve) => {
        chrome.storage.local.get([`${hostname}_vue_data`], (result) => {
            const vueData = result[`${hostname}_vue_data`];
            if (vueData) {
                resolve(vueData);
            } else {
                // 尝试从页面获取
                chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_VUE_ROUTER_DATA' }, () => {
                    // 等待一段时间后再次获取
                    setTimeout(() => {
                        chrome.storage.local.get([`${hostname}_vue_data`], (result2) => {
                            resolve(result2[`${hostname}_vue_data`] || { notFound: true });
                        });
                    }, 1000);
                });
            }
        });
    });
}

// 获取Hook数据
async function getHookData({ scriptId, limit = 50, clear = false } = {}) {
    let data = [...hookDataBuffer];
    
    if (scriptId) {
        data = data.filter(d => d.scriptId === scriptId);
    }
    
    if (clear) {
        if (scriptId) {
            hookDataBuffer = hookDataBuffer.filter(d => d.scriptId !== scriptId);
        } else {
            hookDataBuffer = [];
        }
    }
    
    return data.slice(-limit);
}

// 获取已启用的脚本
async function getEnabledScripts() {
    const tab = await getActiveTab();
    if (!tab || !tab.url) {
        return { enabledScripts: [], mode: 'unknown' };
    }
    
    const hostname = new URL(tab.url).hostname;
    
    return new Promise((resolve) => {
        chrome.storage.local.get(['antidebug_mode', 'global_scripts', hostname], (result) => {
            const mode = result.antidebug_mode || 'standard';
            let enabledScripts;
            
            if (mode === 'global') {
                enabledScripts = result.global_scripts || [];
            } else {
                enabledScripts = result[hostname] || [];
            }
            
            resolve({
                mode,
                hostname,
                enabledScripts
            });
        });
    });
}

// 切换脚本启用状态
async function toggleScript({ scriptId, enabled }) {
    const tab = await getActiveTab();
    if (!tab || !tab.url) {
        throw new Error('无法获取当前标签页');
    }
    
    const hostname = new URL(tab.url).hostname;
    
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['antidebug_mode', 'global_scripts', hostname], (result) => {
            const mode = result.antidebug_mode || 'standard';
            let enabledScripts;
            let storageKey;
            
            if (mode === 'global') {
                enabledScripts = result.global_scripts || [];
                storageKey = 'global_scripts';
            } else {
                enabledScripts = result[hostname] || [];
                storageKey = hostname;
            }
            
            if (enabled) {
                if (!enabledScripts.includes(scriptId)) {
                    enabledScripts.push(scriptId);
                }
            } else {
                enabledScripts = enabledScripts.filter(id => id !== scriptId);
            }
            
            chrome.storage.local.set({ [storageKey]: enabledScripts }, () => {
                // 通知background更新脚本注册
                chrome.runtime.sendMessage({
                    type: 'update_scripts_registration',
                    hostname: mode === 'global' ? '*' : hostname,
                    enabledScripts,
                    isGlobalMode: mode === 'global'
                });
                
                resolve({
                    success: true,
                    scriptId,
                    enabled,
                    enabledScripts
                });
            });
        });
    });
}

// 导航到URL
async function navigateTo({ url }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    // 如果是相对路径，拼接完整URL
    let targetUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        const currentUrl = new URL(tab.url);
        if (url.startsWith('/')) {
            targetUrl = currentUrl.origin + url;
        } else if (url.startsWith('#')) {
            targetUrl = currentUrl.origin + currentUrl.pathname + url;
        } else {
            targetUrl = currentUrl.origin + '/' + url;
        }
    }
    
    await chrome.tabs.update(tab.id, { url: targetUrl });
    return { success: true, url: targetUrl };
}

// 获取Cookie
async function getCookies({ name } = {}) {
    const tab = await getActiveTab();
    if (!tab || !tab.url) {
        throw new Error('无法获取当前标签页');
    }
    
    const url = new URL(tab.url);
    const cookies = await chrome.cookies.getAll({ domain: url.hostname });
    
    let result = cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expirationDate,
        httpOnly: c.httpOnly,
        secure: c.secure
    }));
    
    if (name) {
        result = result.filter(c => c.name.includes(name));
    }
    
    return result;
}

// 获取LocalStorage
async function getLocalStorage({ key } = {}) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (filterKey) => {
                const result = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (!filterKey || k.includes(filterKey)) {
                        result[k] = localStorage.getItem(k);
                    }
                }
                return result;
            },
            args: [key]
        }).then(results => {
            resolve(results[0]?.result || {});
        }).catch(reject);
    });
}

// 获取SessionStorage
async function getSessionStorage({ key } = {}) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (filterKey) => {
                const result = {};
                for (let i = 0; i < sessionStorage.length; i++) {
                    const k = sessionStorage.key(i);
                    if (!filterKey || k.includes(filterKey)) {
                        result[k] = sessionStorage.getItem(k);
                    }
                }
                return result;
            },
            args: [key]
        }).then(results => {
            resolve(results[0]?.result || {});
        }).catch(reject);
    });
}

// 执行脚本
async function executeScript({ code, world = 'MAIN' }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (jsCode) => {
                try {
                    return eval(jsCode);
                } catch (e) {
                    return { error: e.message };
                }
            },
            args: [code],
            world: world
        }).then(results => {
            resolve(results[0]?.result);
        }).catch(reject);
    });
}

// 获取DOM信息
async function getDOMInfo({ selector = 'body', depth = 3 } = {}) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel, maxDepth) => {
                function getElementInfo(el, currentDepth) {
                    if (currentDepth > maxDepth) return null;
                    
                    const info = {
                        tag: el.tagName.toLowerCase(),
                        id: el.id || undefined,
                        classes: el.className ? el.className.split(' ').filter(c => c) : undefined,
                        text: el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 
                            ? el.textContent.trim().substring(0, 100) 
                            : undefined
                    };
                    
                    if (currentDepth < maxDepth && el.children.length > 0) {
                        info.children = Array.from(el.children)
                            .slice(0, 20) // 限制子元素数量
                            .map(child => getElementInfo(child, currentDepth + 1))
                            .filter(c => c);
                    }
                    
                    return info;
                }
                
                const element = document.querySelector(sel);
                if (!element) {
                    return { error: `未找到元素: ${sel}` };
                }
                
                return getElementInfo(element, 0);
            },
            args: [selector, depth]
        }).then(results => {
            resolve(results[0]?.result);
        }).catch(reject);
    });
}

// 配置Hook
async function configureHook({ scriptId, config }) {
    const hookConfig = {};
    
    if (config.keywords) {
        hookConfig.param = config.keywords;
        hookConfig.flag = config.keywords.length > 0 ? 1 : 0;
        hookConfig.keyword_filter_enabled = config.keywords.length > 0;
    }
    
    if (config.enableDebugger !== undefined) {
        hookConfig.debugger = config.enableDebugger ? 1 : 0;
    }
    
    if (config.enableStack !== undefined) {
        hookConfig.stack = config.enableStack ? 1 : 0;
    }
    
    if (config.fixedValue !== undefined) {
        hookConfig.value = config.fixedValue;
    }
    
    return new Promise((resolve) => {
        const configKey = `${scriptId}_config`;
        chrome.storage.local.get([configKey], (result) => {
            const existingConfig = result[configKey] || {};
            const newConfig = { ...existingConfig, ...hookConfig };
            
            chrome.storage.local.set({ [configKey]: newConfig }, () => {
                resolve({
                    success: true,
                    scriptId,
                    config: newConfig
                });
            });
        });
    });
}

// 列出可用脚本
async function listAvailableScripts({ category = 'all' } = {}) {
    return new Promise((resolve) => {
        fetch(chrome.runtime.getURL('scripts.json'))
            .then(response => response.json())
            .then(scripts => {
                if (category !== 'all') {
                    scripts = scripts.filter(s => s.category === category);
                }
                resolve(scripts);
            })
            .catch(() => {
                resolve([]);
            });
    });
}

// 刷新页面
async function refreshPage({ hardRefresh = false } = {}) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    await chrome.tabs.reload(tab.id, { bypassCache: hardRefresh });
    return { success: true };
}

// ===== 新增：浏览器控制功能 =====

// 截图
async function takeScreenshot({ fullPage = false, selector } = {}) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    // 使用 chrome.tabs.captureVisibleTab 截取可见区域
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    
    return {
        success: true,
        dataUrl,
        format: 'png',
        timestamp: Date.now()
    };
}

// 点击元素
async function clickElement({ selector, x, y, dblClick = false }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel, coordX, coordY, isDouble) => {
                let element;
                if (sel) {
                    element = document.querySelector(sel);
                    if (!element) {
                        return { error: `未找到元素: ${sel}` };
                    }
                } else if (coordX !== undefined && coordY !== undefined) {
                    element = document.elementFromPoint(coordX, coordY);
                    if (!element) {
                        return { error: `坐标 (${coordX}, ${coordY}) 处没有元素` };
                    }
                } else {
                    return { error: '必须提供 selector 或 x/y 坐标' };
                }
                
                const clickEvent = new MouseEvent(isDouble ? 'dblclick' : 'click', {
                    bubbles: true,
                    cancelable: true,
                    view: window
                });
                element.dispatchEvent(clickEvent);
                
                return { 
                    success: true, 
                    element: element.tagName,
                    id: element.id,
                    className: element.className
                };
            },
            args: [selector, x, y, dblClick],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 填充输入框
async function fillInput({ selector, value, clear = true }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel, val, shouldClear) => {
                const element = document.querySelector(sel);
                if (!element) {
                    return { error: `未找到元素: ${sel}` };
                }
                
                if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                    element.focus();
                    if (shouldClear) {
                        element.value = '';
                    }
                    element.value = val;
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true, value: element.value };
                } else if (element.tagName === 'SELECT') {
                    element.value = val;
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true, value: element.value };
                } else if (element.isContentEditable) {
                    element.focus();
                    if (shouldClear) {
                        element.textContent = '';
                    }
                    element.textContent = val;
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    return { success: true, value: element.textContent };
                }
                
                return { error: '元素不可编辑' };
            },
            args: [selector, value, clear],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 按键
async function pressKey({ key, modifiers = [] }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (k, mods) => {
                const eventInit = {
                    key: k,
                    code: k,
                    bubbles: true,
                    cancelable: true,
                    ctrlKey: mods.includes('Control') || mods.includes('Ctrl'),
                    shiftKey: mods.includes('Shift'),
                    altKey: mods.includes('Alt'),
                    metaKey: mods.includes('Meta') || mods.includes('Command')
                };
                
                const activeElement = document.activeElement || document.body;
                activeElement.dispatchEvent(new KeyboardEvent('keydown', eventInit));
                activeElement.dispatchEvent(new KeyboardEvent('keypress', eventInit));
                activeElement.dispatchEvent(new KeyboardEvent('keyup', eventInit));
                
                return { success: true, key: k, modifiers: mods };
            },
            args: [key, modifiers],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 获取控制台消息（需要提前注入监听器）
let consoleMessages = [];
async function getConsoleMessages({ limit = 50, types = [] } = {}) {
    let messages = [...consoleMessages];
    
    if (types.length > 0) {
        messages = messages.filter(m => types.includes(m.type));
    }
    
    return messages.slice(-limit);
}

// 滚动页面
async function scrollPage({ x = 0, y = 0, selector, behavior = 'smooth' }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (scrollX, scrollY, sel, scrollBehavior) => {
                if (sel) {
                    const element = document.querySelector(sel);
                    if (element) {
                        element.scrollIntoView({ behavior: scrollBehavior, block: 'center' });
                        return { success: true, scrolledTo: sel };
                    }
                    return { error: `未找到元素: ${sel}` };
                }
                
                window.scrollTo({ left: scrollX, top: scrollY, behavior: scrollBehavior });
                return { success: true, scrollX, scrollY };
            },
            args: [x, y, selector, behavior],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 等待选择器
async function waitForSelector({ selector, timeout = 5000, visible = true }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (sel, timeoutMs, shouldBeVisible) => {
                const startTime = Date.now();
                
                while (Date.now() - startTime < timeoutMs) {
                    const element = document.querySelector(sel);
                    if (element) {
                        if (!shouldBeVisible) {
                            return { success: true, found: true };
                        }
                        const rect = element.getBoundingClientRect();
                        const isVisible = rect.width > 0 && rect.height > 0 && 
                            window.getComputedStyle(element).display !== 'none' &&
                            window.getComputedStyle(element).visibility !== 'hidden';
                        if (isVisible) {
                            return { success: true, found: true, visible: true };
                        }
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
                
                return { success: false, found: false, timeout: true };
            },
            args: [selector, timeout, visible],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 获取元素信息
async function getElementInfo({ selector }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel) => {
                const element = document.querySelector(sel);
                if (!element) {
                    return { error: `未找到元素: ${sel}` };
                }
                
                const rect = element.getBoundingClientRect();
                const styles = window.getComputedStyle(element);
                
                return {
                    tag: element.tagName.toLowerCase(),
                    id: element.id || null,
                    className: element.className || null,
                    text: element.textContent?.trim().substring(0, 200) || null,
                    value: element.value || null,
                    href: element.href || null,
                    src: element.src || null,
                    type: element.type || null,
                    placeholder: element.placeholder || null,
                    disabled: element.disabled || false,
                    checked: element.checked || false,
                    rect: {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                        top: rect.top,
                        left: rect.left
                    },
                    visible: rect.width > 0 && rect.height > 0 && 
                        styles.display !== 'none' && styles.visibility !== 'hidden',
                    attributes: Array.from(element.attributes).reduce((acc, attr) => {
                        acc[attr.name] = attr.value;
                        return acc;
                    }, {})
                };
            },
            args: [selector],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 准备路由访问（启用清除路由守卫和清除跳转脚本）
async function prepareRouteAccess() {
    const scriptsToEnable = [
        'Get_Vue_0',                    // 获取路由
        'Get_Vue_1',                    // 清除跳转
        'Clear_vue_Navigation_Guards'   // 清除路由守卫
    ];
    
    const results = [];
    for (const scriptId of scriptsToEnable) {
        const result = await toggleScript({ scriptId, enabled: true });
        results.push({ scriptId, ...result });
    }
    
    return {
        success: true,
        enabledScripts: scriptsToEnable,
        results,
        message: '已启用路由访问所需脚本，请刷新页面后生效'
    };
}

// 扫描路由收集API
async function scanRouteForAPI({ route, waitTime = 3000 }) {
    // 清空网络请求记录
    const previousRequestCount = networkRequests.length;
    
    // 导航到路由
    await navigateTo({ url: route });
    
    // 等待页面加载和API请求
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    // 获取新增的网络请求
    const newRequests = networkRequests.slice(previousRequestCount);
    
    // 过滤出API请求（通常是XHR/fetch，且URL包含api关键字或特定模式）
    const apiRequests = newRequests.filter(r => {
        const url = r.url.toLowerCase();
        return r.type === 'xmlhttprequest' || 
               r.type === 'fetch' ||
               url.includes('/api/') ||
               url.includes('/api.') ||
               url.includes('.json') ||
               (r.method === 'POST' && !url.endsWith('.js') && !url.endsWith('.css'));
    });
    
    return {
        route,
        totalRequests: newRequests.length,
        apiRequests: apiRequests.map(r => ({
            url: r.url,
            method: r.method,
            type: r.type,
            statusCode: r.statusCode
        })),
        apiCount: apiRequests.length
    };
}

// ===== 新增：加密分析功能 =====

// 存储捕获的加密数据
let capturedEncryptionData = [];

// 启用加密 Hook 并准备捕获
async function enableEncryptionHooks() {
    const scriptsToEnable = [
        'Hook_JSEncrypt',      // RSA 加密
        'Hook_CryptoJS',       // AES/DES/MD5 等
        'hook_log'             // 防止 console.log 被清除
    ];
    
    const results = [];
    for (const scriptId of scriptsToEnable) {
        const result = await toggleScript({ scriptId, enabled: true });
        results.push({ scriptId, ...result });
    }
    
    return {
        success: true,
        enabledScripts: scriptsToEnable,
        results,
        message: '加密 Hook 脚本已启用，刷新页面后生效'
    };
}

// 在页面中注入加密数据捕获器
async function injectEncryptionCapture() {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                // 初始化捕获数组
                window.__encryptionCaptures = window.__encryptionCaptures || [];
                
                // Hook console.log 来捕获加密输出
                const originalLog = console.log;
                console.log = function(...args) {
                    const message = args.join(' ');
                    
                    // 检测 JSEncrypt RSA 输出
                    if (message.includes('JSEncrypt') || message.includes('RSA') || 
                        message.includes('公钥') || message.includes('私钥') ||
                        message.includes('encrypt') || message.includes('decrypt')) {
                        window.__encryptionCaptures.push({
                            type: 'RSA',
                            timestamp: Date.now(),
                            data: args
                        });
                    }
                    
                    // 检测 CryptoJS 输出
                    if (message.includes('CryptoJS') || message.includes('AES') || 
                        message.includes('DES') || message.includes('MD5') ||
                        message.includes('SHA') || message.includes('HMAC')) {
                        window.__encryptionCaptures.push({
                            type: 'CryptoJS',
                            timestamp: Date.now(),
                            data: args
                        });
                    }
                    
                    originalLog.apply(console, args);
                };
                
                return { success: true, message: '加密捕获器已注入' };
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 获取捕获的加密数据
async function getCapturedEncryption() {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                return window.__encryptionCaptures || [];
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || []);
        }).catch(reject);
    });
}

// 分析页面中的加密库和密钥
async function analyzePageEncryption() {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const result = {
                    libraries: {
                        JSEncrypt: typeof JSEncrypt !== 'undefined',
                        CryptoJS: typeof CryptoJS !== 'undefined',
                        forge: typeof forge !== 'undefined',
                        sjcl: typeof sjcl !== 'undefined',
                        aesjs: typeof aesjs !== 'undefined',
                        sm2: typeof sm2 !== 'undefined',
                        sm4: typeof sm4 !== 'undefined'
                    },
                    detectedEncryption: null,
                    keys: {
                        publicKey: null,
                        privateKey: null
                    }
                };
                
                // 尝试从页面脚本中提取密钥
                const scripts = Array.from(document.scripts).filter(s => !s.src);
                for (const script of scripts) {
                    const content = script.textContent || '';
                    
                    // RSA 公钥模式
                    const publicKeyMatch = content.match(/"(MIGfMA[A-Za-z0-9+\/=\\n]+|MFwwDQ[A-Za-z0-9+\/=\\n]+)"/);
                    if (publicKeyMatch) {
                        result.keys.publicKey = publicKeyMatch[1];
                        result.detectedEncryption = 'RSA';
                    }
                    
                    // RSA 私钥模式
                    const privateKeyMatch = content.match(/"(MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT[A-Za-z0-9+\/=\\n]+|MIIB[A-Za-z0-9+\/=\\n]{200,})"/);
                    if (privateKeyMatch) {
                        result.keys.privateKey = privateKeyMatch[1].substring(0, 100) + '...';
                        result.detectedEncryption = 'RSA';
                    }
                }
                
                return result;
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 自动登录并捕获加密数据
async function autoLoginAndCapture({ username, password, usernameSelector, passwordSelector, submitSelector, waitTime = 3000 }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    // 先注入加密捕获器
    await injectEncryptionCapture();
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (user, pwd, userSel, pwdSel, submitSel, wait) => {
                // 清空之前的捕获
                window.__encryptionCaptures = [];
                window.__loginRequest = null;
                
                // Hook XHR 和 fetch 来捕获登录请求
                const originalXHRSend = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.send = function(body) {
                    if (this._url && (this._url.includes('login') || this._url.includes('auth'))) {
                        window.__loginRequest = {
                            url: this._url,
                            method: this._method,
                            body: body,
                            timestamp: Date.now()
                        };
                    }
                    return originalXHRSend.apply(this, arguments);
                };
                
                // 默认选择器
                const usernameInput = document.querySelector(userSel || 'input[type="text"], input[placeholder*="账号"], input[placeholder*="用户"]');
                const passwordInput = document.querySelector(pwdSel || 'input[type="password"]');
                const submitButton = document.querySelector(submitSel || 'button[type="submit"], button:contains("登录"), .login-btn, .el-button--primary');
                
                if (!usernameInput || !passwordInput) {
                    return { error: '找不到登录表单元素' };
                }
                
                // 填写表单
                usernameInput.focus();
                usernameInput.value = user;
                usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
                
                passwordInput.focus();
                passwordInput.value = pwd;
                passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                
                // 等待一下让 Vue 等框架响应
                await new Promise(r => setTimeout(r, 500));
                
                // 点击登录
                if (submitButton) {
                    submitButton.click();
                }
                
                // 等待请求完成
                await new Promise(r => setTimeout(r, wait));
                
                return {
                    success: true,
                    loginRequest: window.__loginRequest,
                    encryptionCaptures: window.__encryptionCaptures,
                    message: '自动登录完成'
                };
            },
            args: [username, password, usernameSelector, passwordSelector, submitSelector, waitTime],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 解密 RSA 加密的数据
async function decryptRSA({ encryptedData, privateKey }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (encrypted, privKey) => {
                // 动态加载 JSEncrypt
                if (typeof JSEncrypt === 'undefined') {
                    const script = document.createElement('script');
                    script.src = 'https://cdn.jsdelivr.net/npm/jsencrypt@3.3.2/bin/jsencrypt.min.js';
                    document.head.appendChild(script);
                    await new Promise(r => script.onload = r);
                }
                
                const decrypt = new JSEncrypt();
                decrypt.setPrivateKey(privKey);
                const decrypted = decrypt.decrypt(encrypted);
                
                return {
                    success: !!decrypted,
                    encrypted: encrypted,
                    decrypted: decrypted,
                    message: decrypted ? '解密成功' : '解密失败'
                };
            },
            args: [encryptedData, privateKey],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 从 JS 文件中提取密钥
async function extractKeysFromJS({ jsUrl }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (url) => {
                try {
                    const response = await fetch(url);
                    const code = await response.text();
                    
                    const result = {
                        jsUrl: url,
                        codeLength: code.length,
                        keys: {
                            rsaPublicKeys: [],
                            rsaPrivateKeys: [],
                            aesKeys: []
                        }
                    };
                    
                    // RSA 公钥
                    const publicKeyMatches = code.match(/"(MIGfMA[A-Za-z0-9+\/=\\n]+|MFwwDQ[A-Za-z0-9+\/=\\n]+)"/g);
                    if (publicKeyMatches) {
                        result.keys.rsaPublicKeys = publicKeyMatches.map(k => k.replace(/"/g, ''));
                    }
                    
                    // RSA 私钥
                    const privateKeyMatches = code.match(/"(MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT[A-Za-z0-9+\/=\\n]+)"/g);
                    if (privateKeyMatches) {
                        result.keys.rsaPrivateKeys = privateKeyMatches.map(k => k.replace(/"/g, ''));
                    }
                    
                    // 检测加密方式
                    result.detectedMethods = {
                        hasJSEncrypt: /JSEncrypt|jsencrypt/i.test(code),
                        hasCryptoJS: /CryptoJS|crypto-js/i.test(code),
                        hasRSA: /RSA|setPublicKey|setPrivateKey/i.test(code),
                        hasAES: /AES|aes/i.test(code),
                        hasMD5: /MD5|md5/i.test(code),
                        hasSM2: /sm2|SM2/i.test(code)
                    };
                    
                    return result;
                } catch (e) {
                    return { error: e.message };
                }
            },
            args: [jsUrl],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// ===== 智能化功能：自动反调试绕过 =====

// 检测页面反调试机制
async function detectAntiDebug() {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const detected = {
                    hasDebugger: false,
                    hasConsoleCheck: false,
                    hasDevtoolsCheck: false,
                    hasTimingCheck: false,
                    hasWindowSizeCheck: false,
                    recommendations: []
                };
                
                // 检查是否有 debugger 语句
                const scripts = Array.from(document.scripts);
                for (const script of scripts) {
                    const content = script.textContent || '';
                    if (/\bdebugger\b/.test(content)) {
                        detected.hasDebugger = true;
                        detected.recommendations.push('Bypass_Debugger');
                    }
                    if (/console\s*\.\s*(log|clear|table)/.test(content) && /=\s*function/.test(content)) {
                        detected.hasConsoleCheck = true;
                        detected.recommendations.push('hook_log', 'hook_clear');
                    }
                    if (/devtools|firebug/i.test(content)) {
                        detected.hasDevtoolsCheck = true;
                        detected.recommendations.push('Fixed_window_size');
                    }
                    if (/performance\.now|Date\.now.*-.*Date\.now/i.test(content)) {
                        detected.hasTimingCheck = true;
                        detected.recommendations.push('hook_table');
                    }
                    if (/innerWidth|innerHeight|outerWidth|outerHeight/i.test(content)) {
                        detected.hasWindowSizeCheck = true;
                        detected.recommendations.push('Fixed_window_size');
                    }
                }
                
                detected.recommendations = [...new Set(detected.recommendations)];
                return detected;
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 自动绕过反调试
async function autoBypassAntiDebug() {
    // 先检测反调试机制
    const detection = await detectAntiDebug();
    
    if (detection.error) {
        return detection;
    }
    
    // 根据检测结果启用相应脚本
    const results = [];
    for (const scriptId of detection.recommendations) {
        const result = await toggleScript({ scriptId, enabled: true });
        results.push({ scriptId, ...result });
    }
    
    return {
        detected: detection,
        enabled: results,
        message: detection.recommendations.length > 0 
            ? `检测到反调试，已启用 ${detection.recommendations.length} 个绕过脚本，请刷新页面`
            : '未检测到明显的反调试机制'
    };
}

// ===== 智能化功能：API 请求分析 =====

// 分析 API 请求签名
async function analyzeAPISignature() {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    // 获取最近的网络请求
    const requests = [...networkRequests].slice(-50);
    
    // 分析请求特征
    const analysis = {
        totalRequests: requests.length,
        methods: {},
        signaturePatterns: [],
        authHeaders: [],
        encryptedParams: []
    };
    
    for (const req of requests) {
        // 统计方法
        analysis.methods[req.method] = (analysis.methods[req.method] || 0) + 1;
        
        // 检测签名参数
        const url = req.url || '';
        if (/sign|signature|token|timestamp|nonce/i.test(url)) {
            const params = new URL(url).searchParams;
            const signParams = {};
            for (const [key, value] of params) {
                if (/sign|token|timestamp|nonce|key/i.test(key)) {
                    signParams[key] = value.length > 50 ? value.substring(0, 50) + '...' : value;
                }
            }
            if (Object.keys(signParams).length > 0) {
                analysis.signaturePatterns.push({ url: url.split('?')[0], params: signParams });
            }
        }
    }
    
    // 去重
    analysis.signaturePatterns = analysis.signaturePatterns.slice(0, 10);
    
    return analysis;
}

// ===== 智能化功能：Vue/React 数据提取 =====

// 提取 Vue 组件数据
async function extractVueData({ selector }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel) => {
                const element = sel ? document.querySelector(sel) : document.querySelector('#app');
                if (!element) {
                    return { error: '未找到元素' };
                }
                
                // Vue 3
                if (element.__vue_app__) {
                    const app = element.__vue_app__;
                    return {
                        version: 'Vue 3',
                        // 获取全局状态
                        globalProperties: Object.keys(app.config.globalProperties || {}),
                        // 获取组件树信息
                        componentCount: document.querySelectorAll('[data-v-]').length
                    };
                }
                
                // Vue 2
                if (element.__vue__) {
                    const vm = element.__vue__;
                    return {
                        version: 'Vue 2',
                        data: vm.$data,
                        computed: Object.keys(vm.$options.computed || {}),
                        methods: Object.keys(vm.$options.methods || {})
                    };
                }
                
                // 搜索子元素中的 Vue 实例
                const vueElements = element.querySelectorAll('*');
                for (const el of vueElements) {
                    if (el.__vue__) {
                        return {
                            version: 'Vue 2',
                            data: el.__vue__.$data,
                            path: el.tagName
                        };
                    }
                }
                
                return { error: '未检测到 Vue 实例' };
            },
            args: [selector],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 提取 React 组件数据
async function extractReactData({ selector }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel) => {
                const element = sel ? document.querySelector(sel) : document.querySelector('#root, #app');
                if (!element) {
                    return { error: '未找到元素' };
                }
                
                // 查找 React Fiber
                const key = Object.keys(element).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
                if (key) {
                    const fiber = element[key];
                    return {
                        version: 'React',
                        componentName: fiber?.type?.name || fiber?.type?.displayName || 'Unknown',
                        hasProps: !!fiber?.memoizedProps,
                        hasState: !!fiber?.memoizedState
                    };
                }
                
                return { error: '未检测到 React 实例' };
            },
            args: [selector],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// ===== 智能化功能：认证分析 =====

// 分析认证机制
async function analyzeAuthentication() {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    // 获取 Cookie
    const cookies = await getCookies({});
    
    // 获取 localStorage
    const storage = await getLocalStorage({});
    
    // 分析认证相关数据
    const analysis = {
        cookies: {
            total: cookies.length,
            authRelated: cookies.filter(c => 
                /token|auth|session|jwt|access|refresh/i.test(c.name)
            ).map(c => ({
                name: c.name,
                value: c.value.length > 50 ? c.value.substring(0, 50) + '...' : c.value,
                httpOnly: c.httpOnly,
                secure: c.secure
            }))
        },
        localStorage: {
            total: Object.keys(storage).length,
            authRelated: Object.entries(storage)
                .filter(([k]) => /token|auth|user|login|jwt/i.test(k))
                .map(([k, v]) => ({
                    key: k,
                    value: typeof v === 'string' && v.length > 100 ? v.substring(0, 100) + '...' : v
                }))
        },
        tokenAnalysis: null
    };
    
    // 尝试解析 JWT
    for (const item of [...analysis.cookies.authRelated, ...analysis.localStorage.authRelated]) {
        const value = item.value || '';
        if (value.split('.').length === 3) {
            try {
                const payload = JSON.parse(atob(value.split('.')[1]));
                analysis.tokenAnalysis = {
                    type: 'JWT',
                    source: item.name || item.key,
                    payload: payload
                };
                break;
            } catch (e) {}
        }
    }
    
    return analysis;
}

// ===== 智能化功能：表单自动化 =====

// 获取页面所有表单信息
async function getPageForms() {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const forms = Array.from(document.querySelectorAll('form, [class*="form"], [class*="login"]'));
                return forms.map((form, index) => {
                    const inputs = Array.from(form.querySelectorAll('input, select, textarea'));
                    const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));
                    
                    return {
                        index,
                        id: form.id || null,
                        className: form.className || null,
                        action: form.action || null,
                        method: form.method || null,
                        inputs: inputs.map(input => ({
                            type: input.type,
                            name: input.name,
                            id: input.id,
                            placeholder: input.placeholder,
                            selector: input.id ? `#${input.id}` : 
                                      input.name ? `[name="${input.name}"]` :
                                      `input[type="${input.type}"]`
                        })),
                        buttons: buttons.map(btn => ({
                            text: btn.textContent?.trim(),
                            type: btn.type,
                            selector: btn.id ? `#${btn.id}` : 
                                      btn.className ? `.${btn.className.split(' ')[0]}` : 'button'
                        }))
                    };
                });
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || []);
        }).catch(reject);
    });
}

// 自动填充表单
async function autoFillForm({ formIndex = 0, values }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (idx, vals) => {
                const forms = Array.from(document.querySelectorAll('form, [class*="form"], [class*="login"]'));
                const form = forms[idx];
                if (!form) {
                    return { error: `未找到表单 ${idx}` };
                }
                
                const filled = [];
                for (const [selector, value] of Object.entries(vals)) {
                    const input = form.querySelector(selector) || document.querySelector(selector);
                    if (input) {
                        input.focus();
                        input.value = value;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        filled.push({ selector, value });
                    }
                }
                
                return { success: true, filled };
            },
            args: [formIndex, values],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// ===== 智能化功能：WebSocket 监控 =====
let wsMessages = [];

// 注入 WebSocket 监控
async function injectWSMonitor() {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                window.__wsMessages = window.__wsMessages || [];
                
                const OriginalWebSocket = window.WebSocket;
                window.WebSocket = function(url, protocols) {
                    const ws = new OriginalWebSocket(url, protocols);
                    
                    ws.addEventListener('message', (event) => {
                        window.__wsMessages.push({
                            type: 'receive',
                            url: url,
                            data: event.data,
                            timestamp: Date.now()
                        });
                    });
                    
                    const originalSend = ws.send.bind(ws);
                    ws.send = function(data) {
                        window.__wsMessages.push({
                            type: 'send',
                            url: url,
                            data: data,
                            timestamp: Date.now()
                        });
                        return originalSend(data);
                    };
                    
                    return ws;
                };
                window.WebSocket.prototype = OriginalWebSocket.prototype;
                
                return { success: true, message: 'WebSocket 监控已注入' };
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 获取 WebSocket 消息
async function getWSMessages({ limit = 50 } = {}) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (lim) => {
                return (window.__wsMessages || []).slice(-lim);
            },
            args: [limit],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || []);
        }).catch(reject);
    });
}

// ===== 智能化功能：页面数据爬取 =====

// 提取页面结构化数据
async function extractPageData({ selectors }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sels) => {
                const result = {};
                for (const [name, selector] of Object.entries(sels)) {
                    const elements = document.querySelectorAll(selector);
                    result[name] = Array.from(elements).map(el => ({
                        text: el.textContent?.trim(),
                        html: el.innerHTML?.substring(0, 200),
                        href: el.href || null,
                        src: el.src || null
                    }));
                }
                return result;
            },
            args: [selectors],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 提取表格数据
async function extractTableData({ selector }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel) => {
                const table = document.querySelector(sel || 'table');
                if (!table) {
                    return { error: '未找到表格' };
                }
                
                const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent?.trim());
                const rows = Array.from(table.querySelectorAll('tbody tr')).map(tr => {
                    return Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim());
                });
                
                return { headers, rows, rowCount: rows.length };
            },
            args: [selector],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// ===== Burp Suite 格式网络请求 =====

// 存储详细的请求数据（包括请求头和响应）
let detailedRequests = [];
const MAX_DETAILED_REQUESTS = 200;

// 添加详细请求
function addDetailedRequest(request) {
    detailedRequests.push(request);
    if (detailedRequests.length > MAX_DETAILED_REQUESTS) {
        detailedRequests = detailedRequests.slice(-MAX_DETAILED_REQUESTS);
    }
}

// 点击元素并捕获请求
async function clickAndCapture({ selector, waitTime = 3000 }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    // 记录点击前的请求数量
    const beforeCount = networkRequests.length;
    
    // 注入请求拦截器
    await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                // 初始化捕获数组
                window.__capturedRequests = [];
                
                // Hook XHR
                const originalXHROpen = XMLHttpRequest.prototype.open;
                const originalXHRSend = XMLHttpRequest.prototype.send;
                const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
                
                XMLHttpRequest.prototype.open = function(method, url) {
                    this._captureData = { method, url, headers: {}, startTime: Date.now() };
                    return originalXHROpen.apply(this, arguments);
                };
                
                XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                    if (this._captureData) {
                        this._captureData.headers[name] = value;
                    }
                    return originalXHRSetHeader.apply(this, arguments);
                };
                
                XMLHttpRequest.prototype.send = function(body) {
                    if (this._captureData) {
                        this._captureData.body = body;
                        const capture = this._captureData;
                        
                        this.addEventListener('load', function() {
                            capture.status = this.status;
                            capture.statusText = this.statusText;
                            capture.responseHeaders = this.getAllResponseHeaders();
                            capture.response = this.responseText?.substring(0, 10000);
                            capture.endTime = Date.now();
                            window.__capturedRequests.push(capture);
                        });
                    }
                    return originalXHRSend.apply(this, arguments);
                };
                
                // Hook Fetch
                const originalFetch = window.fetch;
                window.fetch = async function(input, init = {}) {
                    const url = typeof input === 'string' ? input : input.url;
                    const method = init.method || 'GET';
                    const headers = init.headers || {};
                    const body = init.body;
                    
                    const capture = {
                        method,
                        url,
                        headers: headers instanceof Headers ? Object.fromEntries(headers) : headers,
                        body: typeof body === 'string' ? body : (body ? '[Binary]' : null),
                        startTime: Date.now()
                    };
                    
                    try {
                        const response = await originalFetch.apply(this, arguments);
                        capture.status = response.status;
                        capture.statusText = response.statusText;
                        capture.responseHeaders = Object.fromEntries(response.headers);
                        
                        // Clone response to read body
                        const cloned = response.clone();
                        try {
                            capture.response = (await cloned.text()).substring(0, 10000);
                        } catch (e) {
                            capture.response = '[Binary or Error]';
                        }
                        
                        capture.endTime = Date.now();
                        window.__capturedRequests.push(capture);
                        
                        return response;
                    } catch (error) {
                        capture.error = error.message;
                        capture.endTime = Date.now();
                        window.__capturedRequests.push(capture);
                        throw error;
                    }
                };
                
                return { success: true };
            },
            world: 'MAIN'
        }).then(resolve).catch(reject);
    });
    
    // 点击元素
    await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel) => {
                const element = document.querySelector(sel);
                if (!element) {
                    return { error: `未找到元素: ${sel}` };
                }
                element.click();
                return { success: true, clicked: sel };
            },
            args: [selector],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '点击失败' });
        }).catch(reject);
    });
    
    // 等待请求完成
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    // 获取捕获的请求
    const captured = await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.__capturedRequests || [],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || []);
        }).catch(reject);
    });
    
    return {
        clickedSelector: selector,
        capturedCount: captured.length,
        requests: captured
    };
}

// 转换为 Burp Suite 格式
function toBurpFormat(requests) {
    return requests.map((req, index) => {
        const url = new URL(req.url, 'http://localhost');
        const host = url.hostname;
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        const path = url.pathname + url.search;
        
        // 构建请求头
        let requestHeaders = `${req.method} ${path} HTTP/1.1\r\n`;
        requestHeaders += `Host: ${host}\r\n`;
        
        if (req.headers) {
            for (const [name, value] of Object.entries(req.headers)) {
                if (name.toLowerCase() !== 'host') {
                    requestHeaders += `${name}: ${value}\r\n`;
                }
            }
        }
        
        // 常见请求头补充
        if (!req.headers?.['User-Agent']) {
            requestHeaders += `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0\r\n`;
        }
        if (!req.headers?.['Accept']) {
            requestHeaders += `Accept: application/json, text/plain, */*\r\n`;
        }
        if (req.body && !req.headers?.['Content-Type']) {
            requestHeaders += `Content-Type: application/json\r\n`;
        }
        if (req.body) {
            const bodyLength = typeof req.body === 'string' ? req.body.length : 0;
            requestHeaders += `Content-Length: ${bodyLength}\r\n`;
        }
        
        requestHeaders += `\r\n`;
        
        // 请求体
        if (req.body) {
            requestHeaders += req.body;
        }
        
        // 构建响应头
        let responseHeaders = '';
        if (req.status) {
            responseHeaders = `HTTP/1.1 ${req.status} ${req.statusText || 'OK'}\r\n`;
            
            if (typeof req.responseHeaders === 'string') {
                responseHeaders += req.responseHeaders;
            } else if (req.responseHeaders) {
                for (const [name, value] of Object.entries(req.responseHeaders)) {
                    responseHeaders += `${name}: ${value}\r\n`;
                }
            }
            
            responseHeaders += `\r\n`;
            
            if (req.response) {
                responseHeaders += req.response;
            }
        }
        
        return {
            index: index + 1,
            host,
            port,
            protocol: url.protocol.replace(':', ''),
            method: req.method,
            path,
            status: req.status,
            length: req.response?.length || 0,
            duration: req.endTime && req.startTime ? `${req.endTime - req.startTime}ms` : 'N/A',
            request: requestHeaders,
            response: responseHeaders,
            // 原始数据
            raw: req
        };
    });
}

// 获取 Burp 格式的网络请求
async function getNetworkRequestsBurp({ filter, limit = 50 } = {}) {
    let requests = [...networkRequests].slice(-limit);
    
    if (filter) {
        requests = requests.filter(r => r.url?.toLowerCase().includes(filter.toLowerCase()));
    }
    
    return {
        total: requests.length,
        burpFormat: toBurpFormat(requests)
    };
}

// 点击并获取 Burp 格式请求
async function clickAndGetBurp({ selector, waitTime = 3000 }) {
    const result = await clickAndCapture({ selector, waitTime });
    
    if (result.error) {
        return result;
    }
    
    const burpRequests = toBurpFormat(result.requests);
    
    return {
        clicked: result.clickedSelector,
        totalRequests: result.capturedCount,
        burpRequests
    };
}

// 自动登录并获取 Burp 格式请求
async function loginAndGetBurp({ username, password, usernameSelector, passwordSelector, submitSelector, waitTime = 3000 }) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    // 先注入请求拦截器
    await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                window.__capturedRequests = [];
                
                // Hook XHR
                const originalXHROpen = XMLHttpRequest.prototype.open;
                const originalXHRSend = XMLHttpRequest.prototype.send;
                const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
                
                XMLHttpRequest.prototype.open = function(method, url) {
                    this._captureData = { method, url, headers: {}, startTime: Date.now() };
                    return originalXHROpen.apply(this, arguments);
                };
                
                XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                    if (this._captureData) {
                        this._captureData.headers[name] = value;
                    }
                    return originalXHRSetHeader.apply(this, arguments);
                };
                
                XMLHttpRequest.prototype.send = function(body) {
                    if (this._captureData) {
                        this._captureData.body = body;
                        const capture = this._captureData;
                        
                        this.addEventListener('load', function() {
                            capture.status = this.status;
                            capture.statusText = this.statusText;
                            capture.responseHeaders = this.getAllResponseHeaders();
                            capture.response = this.responseText?.substring(0, 10000);
                            capture.endTime = Date.now();
                            window.__capturedRequests.push(capture);
                        });
                    }
                    return originalXHRSend.apply(this, arguments);
                };
                
                // Hook Fetch
                const originalFetch = window.fetch;
                window.fetch = async function(input, init = {}) {
                    const url = typeof input === 'string' ? input : input.url;
                    const method = init.method || 'GET';
                    const headers = init.headers || {};
                    const body = init.body;
                    
                    const capture = {
                        method,
                        url,
                        headers: headers instanceof Headers ? Object.fromEntries(headers) : headers,
                        body: typeof body === 'string' ? body : (body ? '[Binary]' : null),
                        startTime: Date.now()
                    };
                    
                    try {
                        const response = await originalFetch.apply(this, arguments);
                        capture.status = response.status;
                        capture.statusText = response.statusText;
                        capture.responseHeaders = Object.fromEntries(response.headers);
                        
                        const cloned = response.clone();
                        try {
                            capture.response = (await cloned.text()).substring(0, 10000);
                        } catch (e) {
                            capture.response = '[Binary]';
                        }
                        
                        capture.endTime = Date.now();
                        window.__capturedRequests.push(capture);
                        return response;
                    } catch (error) {
                        capture.error = error.message;
                        capture.endTime = Date.now();
                        window.__capturedRequests.push(capture);
                        throw error;
                    }
                };
                
                return { success: true };
            },
            world: 'MAIN'
        }).then(resolve).catch(reject);
    });
    
    // 填写表单
    await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (user, pwd, userSel, pwdSel) => {
                const usernameInput = document.querySelector(userSel || 'input[type="text"], input[placeholder*="账号"], input[placeholder*="用户"], input[name="username"]');
                const passwordInput = document.querySelector(pwdSel || 'input[type="password"]');
                
                if (usernameInput) {
                    usernameInput.focus();
                    usernameInput.value = user;
                    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
                    usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
                
                if (passwordInput) {
                    passwordInput.focus();
                    passwordInput.value = pwd;
                    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                    passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
                
                return { usernameFound: !!usernameInput, passwordFound: !!passwordInput };
            },
            args: [username, password, usernameSelector, passwordSelector],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '填写失败' });
        }).catch(reject);
    });
    
    // 等待表单响应
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 点击登录按钮
    await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (submitSel) => {
                const submitBtn = document.querySelector(submitSel || 'button[type="submit"], .login-btn, .el-button--primary, button.ant-btn-primary');
                if (submitBtn) {
                    submitBtn.click();
                    return { clicked: true };
                }
                // 尝试查找包含"登录"文字的按钮
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent && btn.textContent.includes('登录')) {
                        btn.click();
                        return { clicked: true, text: btn.textContent };
                    }
                }
                return { clicked: false, error: '未找到登录按钮' };
            },
            args: [submitSelector],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '点击失败' });
        }).catch(reject);
    });
    
    // 等待请求完成
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    // 获取捕获的请求
    const captured = await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.__capturedRequests || [],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || []);
        }).catch(reject);
    });
    
    return {
        username,
        password,
        totalRequests: captured.length,
        burpRequests: toBurpFormat(captured)
    };
}

// ===== 敏感数据检测功能 =====

// 存储捕获的请求响应体
let requestsWithBody = [];
const MAX_REQUESTS_WITH_BODY = 100;

// 敏感数据告警
let sensitiveAlerts = [];
let sensitiveMonitorEnabled = false;
let sensitiveMonitorPatterns = ['idCard', 'phone', 'bankCard', 'password'];

// 获取带响应体的网络请求
async function getNetworkRequestsWithBody({ filter, limit = 20 } = {}) {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    // 先注入请求拦截器（如果尚未注入）
    await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                if (window.__requestBodyCapture) {
                    return { alreadyInjected: true, requests: window.__capturedRequestsWithBody || [] };
                }
                
                window.__requestBodyCapture = true;
                window.__capturedRequestsWithBody = window.__capturedRequestsWithBody || [];
                
                // Hook XHR
                const originalXHROpen = XMLHttpRequest.prototype.open;
                const originalXHRSend = XMLHttpRequest.prototype.send;
                
                XMLHttpRequest.prototype.open = function(method, url) {
                    this._captureInfo = { method, url, startTime: Date.now() };
                    return originalXHROpen.apply(this, arguments);
                };
                
                XMLHttpRequest.prototype.send = function(body) {
                    if (this._captureInfo) {
                        this._captureInfo.requestBody = body;
                        const info = this._captureInfo;
                        
                        this.addEventListener('load', function() {
                            info.statusCode = this.status;
                            info.responseBody = this.responseText?.substring(0, 50000); // 限制响应体大小
                            info.endTime = Date.now();
                            window.__capturedRequestsWithBody.push(info);
                            
                            // 限制数量
                            if (window.__capturedRequestsWithBody.length > 100) {
                                window.__capturedRequestsWithBody = window.__capturedRequestsWithBody.slice(-100);
                            }
                        });
                    }
                    return originalXHRSend.apply(this, arguments);
                };
                
                // Hook Fetch
                const originalFetch = window.fetch;
                window.fetch = async function(input, init = {}) {
                    const url = typeof input === 'string' ? input : input.url;
                    const method = init.method || 'GET';
                    const info = { method, url, startTime: Date.now(), requestBody: init.body };
                    
                    try {
                        const response = await originalFetch.apply(this, arguments);
                        info.statusCode = response.status;
                        
                        const cloned = response.clone();
                        try {
                            info.responseBody = (await cloned.text()).substring(0, 50000);
                        } catch (e) {
                            info.responseBody = '[无法读取]';
                        }
                        
                        info.endTime = Date.now();
                        window.__capturedRequestsWithBody.push(info);
                        
                        if (window.__capturedRequestsWithBody.length > 100) {
                            window.__capturedRequestsWithBody = window.__capturedRequestsWithBody.slice(-100);
                        }
                        
                        return response;
                    } catch (error) {
                        info.error = error.message;
                        info.endTime = Date.now();
                        window.__capturedRequestsWithBody.push(info);
                        throw error;
                    }
                };
                
                return { injected: true };
            },
            world: 'MAIN'
        }).then(resolve).catch(reject);
    });
    
    // 获取捕获的请求
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (filterStr, maxLimit) => {
                let requests = window.__capturedRequestsWithBody || [];
                if (filterStr) {
                    requests = requests.filter(r => r.url?.toLowerCase().includes(filterStr.toLowerCase()));
                }
                return requests.slice(-maxLimit);
            },
            args: [filter, limit],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || []);
        }).catch(reject);
    });
}

// 获取页面内容（用于敏感数据扫描）
async function getPageContent() {
    const tab = await getActiveTab();
    if (!tab) {
        throw new Error('无法获取当前标签页');
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                // 获取页面主要文本内容
                const body = document.body;
                if (!body) return '';
                
                // 移除脚本和样式内容
                const clone = body.cloneNode(true);
                const scripts = clone.querySelectorAll('script, style, noscript');
                scripts.forEach(s => s.remove());
                
                return clone.textContent || '';
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || '');
        }).catch(reject);
    });
}

// 启动敏感数据监控
async function startSensitiveMonitor({ patterns = ['idCard', 'phone', 'bankCard', 'password'], alertOnCritical = true } = {}) {
    sensitiveMonitorEnabled = true;
    sensitiveMonitorPatterns = patterns;
    
    const tab = await getActiveTab();
    if (!tab) {
        return { success: false, error: '无法获取当前标签页' };
    }
    
    // 注入实时监控脚本
    await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (patternsToMonitor, shouldAlert) => {
                window.__sensitiveMonitor = {
                    enabled: true,
                    patterns: patternsToMonitor,
                    alertOnCritical: shouldAlert,
                    alerts: []
                };
                
                // 敏感数据正则
                const PATTERNS = {
                    idCard: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
                    phone: /\b1[3-9]\d{9}\b/g,
                    bankCard: /\b(?:62|4[0-9]|5[1-5]|6[2-6])\d{14,17}\b/g,
                    password: /"(?:password|passwd|pwd)"\s*:\s*"[^"]+"/gi,
                    jwt: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
                };
                
                // Hook XHR 响应
                const originalXHROpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, url) {
                    this._monitorUrl = url;
                    return originalXHROpen.apply(this, arguments);
                };
                
                const originalXHRGet = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText').get;
                Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
                    get: function() {
                        const text = originalXHRGet.call(this);
                        if (text && window.__sensitiveMonitor?.enabled) {
                            checkSensitiveData(text, this._monitorUrl, 'XHR');
                        }
                        return text;
                    }
                });
                
                // 检测函数
                function checkSensitiveData(text, url, source) {
                    const monitor = window.__sensitiveMonitor;
                    if (!monitor || !monitor.enabled) return;
                    
                    for (const patternName of monitor.patterns) {
                        const regex = PATTERNS[patternName];
                        if (!regex) continue;
                        
                        const matches = text.match(regex);
                        if (matches && matches.length > 0) {
                            const alert = {
                                timestamp: Date.now(),
                                url,
                                source,
                                type: patternName,
                                severity: ['idCard', 'bankCard', 'password'].includes(patternName) ? 'critical' : 'high',
                                matchCount: matches.length,
                                sample: matches[0]?.substring(0, 20) + '...'
                            };
                            
                            monitor.alerts.push(alert);
                            
                            // 控制台告警
                            if (monitor.alertOnCritical && alert.severity === 'critical') {
                                console.warn(`🚨 [敏感数据告警] ${patternName}: 在 ${url} 发现 ${matches.length} 处`);
                            }
                        }
                    }
                }
                
                return { success: true, message: '敏感数据监控已启动' };
            },
            args: [patterns, alertOnCritical],
            world: 'MAIN'
        }).then(resolve).catch(reject);
    });
    
    return { 
        success: true, 
        message: '敏感数据监控已启动',
        patterns: sensitiveMonitorPatterns
    };
}

// 获取敏感数据告警
async function getSensitiveAlerts({ limit = 50, severityFilter = 'all' } = {}) {
    const tab = await getActiveTab();
    if (!tab) {
        return [];
    }
    
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (maxLimit, severity) => {
                const monitor = window.__sensitiveMonitor;
                if (!monitor) {
                    return { enabled: false, alerts: [] };
                }
                
                let alerts = monitor.alerts || [];
                if (severity !== 'all') {
                    alerts = alerts.filter(a => a.severity === severity);
                }
                
                return {
                    enabled: monitor.enabled,
                    totalAlerts: monitor.alerts?.length || 0,
                    filteredAlerts: alerts.slice(-maxLimit),
                    patterns: monitor.patterns
                };
            },
            args: [limit, severityFilter],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { enabled: false, alerts: [] });
        }).catch(reject);
    });
}

// ============== 发送当前页面信息 ==============
async function sendCurrentPageInfo() {
    try {
        const pageInfo = await getPageInfo();
        sendToMCP('PAGE_INFO', pageInfo);
    } catch (e) {
        console.warn('[MCP Client] 发送页面信息失败:', e);
    }
}

// ============== Hook数据收集 ==============
function addHookData(data) {
    hookDataBuffer.push({
        ...data,
        timestamp: Date.now()
    });
    
    // 限制缓冲区大小
    if (hookDataBuffer.length > 500) {
        hookDataBuffer = hookDataBuffer.slice(-500);
    }
    
    // 实时推送到MCP
    if (isConnected) {
        sendToMCP('HOOK_DATA', data);
    }
}

// ============== 网络请求拦截 ==============
function addNetworkRequest(request) {
    networkRequests.push({
        ...request,
        timestamp: Date.now()
    });
    
    // 限制缓冲区大小
    if (networkRequests.length > 1000) {
        networkRequests = networkRequests.slice(-1000);
    }
    
    // 实时推送到MCP
    if (isConnected) {
        sendToMCP('NETWORK_REQUEST', request);
    }
}

// 使用 chrome.webRequest 监听所有网络请求
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        // 只捕获 API 请求（XHR/fetch），排除静态资源
        if (details.type === 'xmlhttprequest' || details.type === 'fetch') {
            addNetworkRequest({
                url: details.url,
                method: details.method,
                type: details.type,
                tabId: details.tabId,
                requestId: details.requestId,
                initiator: details.initiator
            });
        }
    },
    { urls: ['<all_urls>'] }
);

// 监听请求完成，获取响应状态
chrome.webRequest.onCompleted.addListener(
    (details) => {
        if (details.type === 'xmlhttprequest' || details.type === 'fetch') {
            // 更新已存在的请求记录
            const existingIndex = networkRequests.findIndex(r => r.requestId === details.requestId);
            if (existingIndex !== -1) {
                networkRequests[existingIndex].statusCode = details.statusCode;
                networkRequests[existingIndex].completed = true;
            }
        }
    },
    { urls: ['<all_urls>'] }
);

// ============== 监听存储变化 ==============
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        // MCP启用状态变化
        if (changes.mcp_enabled) {
            mcpEnabled = changes.mcp_enabled.newValue === true;
            if (mcpEnabled) {
                reconnectAttempts = 0;
                connectToMCP();
            } else {
                disconnectFromMCP();
            }
        }
        
        // 脚本启用状态变化
        if (changes.global_scripts || Object.keys(changes).some(k => k.includes('.'))) {
            if (isConnected) {
                getEnabledScripts().then(scripts => {
                    sendToMCP('SCRIPTS_UPDATED', scripts);
                });
            }
        }
    }
});

// ============== 监听来自content script的消息 ==============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 处理Hook数据
    if (message.type === 'MCP_HOOK_DATA') {
        addHookData(message.data);
        sendResponse({ success: true });
        return true;
    }
    
    // 处理网络请求
    if (message.type === 'MCP_NETWORK_REQUEST') {
        addNetworkRequest(message.data);
        sendResponse({ success: true });
        return true;
    }
    
    // 获取MCP连接状态（实时检查）
    if (message.type === 'GET_MCP_STATUS') {
        // 实时检查 WebSocket 状态
        const actuallyConnected = ws && ws.readyState === WebSocket.OPEN && isConnected;
        const isConnecting = ws && ws.readyState === WebSocket.CONNECTING;
        
        // 如果状态不一致，同步更新
        if (isConnected && !actuallyConnected) {
            console.log('[MCP Client] 状态不一致，更新为断开');
            handleDisconnect();
        }
        
        // 判断是否连接失败（重连次数用尽且未连接）
        const hasError = mcpEnabled && !actuallyConnected && !isConnecting && reconnectAttempts >= MAX_RECONNECT_ATTEMPTS;
        
        sendResponse({ 
            connected: actuallyConnected, 
            enabled: mcpEnabled,
            connecting: isConnecting,
            error: hasError,
            wsUrl: getMCPWsUrl(),
            port: mcpPort,
            wsState: ws ? ws.readyState : -1, // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
            reconnectAttempts: reconnectAttempts,
            maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
            lastPongTime: lastPongTime
        });
        return true;
    }
    
    // 重新连接MCP（端口变更时调用）
    if (message.type === 'RECONNECT_MCP') {
        console.log('[MCP Client] 收到重连请求');
        
        // 先断开现有连接
        disconnectFromMCP();
        
        // 重新读取配置并连接
        chrome.storage.local.get(['mcp_enabled', 'mcp_port'], (result) => {
            mcpEnabled = result.mcp_enabled === true;
            mcpPort = result.mcp_port || MCP_DEFAULT_PORT;
            
            console.log('[MCP Client] 重新连接，端口:', mcpPort);
            
            if (mcpEnabled) {
                reconnectAttempts = 0; // 重置重连计数
                connectToMCP();
            }
        });
        
        sendResponse({ success: true });
        return true;
    }
    
    return false;
});

// ============== 监听标签页变化 ==============
chrome.tabs.onActivated.addListener(() => {
    if (isConnected) {
        sendCurrentPageInfo();
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' && isConnected) {
        sendCurrentPageInfo();
    }
});

// ===== 请求头管理功能 =====

// 获取请求头配置
async function getHeadersConfig() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group'], (result) => {
            const groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};
            const currentGroupId = result.current_headers_group || null;
            
            // 构建完整的配置信息
            const config = {
                currentGroupId,
                groups: groups.map(g => ({
                    ...g,
                    headers: data[g.id] || [],
                    isCurrent: g.id === currentGroupId
                })),
                totalGroups: groups.length,
                totalHeaders: Object.values(data).flat().length
            };
            
            resolve(config);
        });
    });
}

// 创建请求头组
async function createHeaderGroup({ name, headers = [] }) {
    return new Promise((resolve, reject) => {
        if (!name || !name.trim()) {
            reject(new Error('请求头组名称不能为空'));
            return;
        }
        
        chrome.storage.local.get(['global_headers_groups', 'global_headers_data'], (result) => {
            const groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};
            
            // 生成唯一ID
            const groupId = `hg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            
            // 添加新组
            const newGroup = {
                id: groupId,
                name: name.trim(),
                createdAt: Date.now()
            };
            groups.push(newGroup);
            
            // 初始化请求头数据
            data[groupId] = headers.map((h, index) => ({
                id: `h_${Date.now()}_${index}`,
                name: h.name || '',
                value: h.value || '',
                enabled: h.enabled !== false
            }));
            
            chrome.storage.local.set({
                global_headers_groups: groups,
                global_headers_data: data
            }, () => {
                resolve({
                    success: true,
                    groupId,
                    group: newGroup,
                    message: `请求头组 "${name}" 创建成功`
                });
            });
        });
    });
}

// 删除请求头组
async function deleteHeaderGroup({ groupId }) {
    return new Promise((resolve, reject) => {
        if (!groupId) {
            reject(new Error('请求头组ID不能为空'));
            return;
        }
        
        chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group'], (result) => {
            let groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};
            let currentGroupId = result.current_headers_group;
            
            // 查找并删除组
            const groupIndex = groups.findIndex(g => g.id === groupId);
            if (groupIndex === -1) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            const deletedGroup = groups[groupIndex];
            groups = groups.filter(g => g.id !== groupId);
            delete data[groupId];
            
            // 如果删除的是当前组，清空当前选择
            if (currentGroupId === groupId) {
                currentGroupId = null;
                // 清除所有请求头规则
                chrome.runtime.sendMessage({
                    type: 'UPDATE_GLOBAL_HEADERS',
                    headers: []
                });
            }
            
            chrome.storage.local.set({
                global_headers_groups: groups,
                global_headers_data: data,
                current_headers_group: currentGroupId
            }, () => {
                resolve({
                    success: true,
                    deletedGroupId: groupId,
                    deletedGroupName: deletedGroup.name,
                    message: `请求头组 "${deletedGroup.name}" 已删除`
                });
            });
        });
    });
}

// 切换当前请求头组
async function switchHeaderGroup({ groupId }) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group'], (result) => {
            const groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};
            
            // 如果 groupId 为 null 或空，则禁用所有请求头
            if (!groupId) {
                chrome.storage.local.set({ current_headers_group: null }, () => {
                    chrome.runtime.sendMessage({
                        type: 'UPDATE_GLOBAL_HEADERS',
                        headers: []
                    });
                    resolve({
                        success: true,
                        currentGroupId: null,
                        message: '已禁用所有请求头'
                    });
                });
                return;
            }
            
            // 验证组是否存在
            const group = groups.find(g => g.id === groupId);
            if (!group) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            // 获取该组的启用请求头
            const groupHeaders = data[groupId] || [];
            const enabledHeaders = groupHeaders
                .filter(h => h.enabled && h.name && h.name.trim())
                .map(h => ({ name: h.name.trim(), value: h.value || '' }));
            
            // 更新当前组
            chrome.storage.local.set({ current_headers_group: groupId }, () => {
                // 通知 background 更新请求头规则
                chrome.runtime.sendMessage({
                    type: 'UPDATE_GLOBAL_HEADERS',
                    headers: enabledHeaders
                });
                
                resolve({
                    success: true,
                    currentGroupId: groupId,
                    groupName: group.name,
                    enabledHeaders: enabledHeaders.length,
                    message: `已切换到请求头组 "${group.name}"，${enabledHeaders.length} 个请求头已启用`
                });
            });
        });
    });
}

// 添加单个请求头
async function addHeader({ groupId, name, value, enabled = true }) {
    return new Promise((resolve, reject) => {
        if (!groupId) {
            reject(new Error('请求头组ID不能为空'));
            return;
        }
        if (!name || !name.trim()) {
            reject(new Error('请求头名称不能为空'));
            return;
        }
        
        chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group'], (result) => {
            const groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};
            const currentGroupId = result.current_headers_group;
            
            // 验证组是否存在
            const group = groups.find(g => g.id === groupId);
            if (!group) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            // 添加请求头
            const headerId = `h_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const newHeader = {
                id: headerId,
                name: name.trim(),
                value: value || '',
                enabled: enabled
            };
            
            if (!data[groupId]) {
                data[groupId] = [];
            }
            data[groupId].push(newHeader);
            
            chrome.storage.local.set({ global_headers_data: data }, () => {
                // 如果是当前组，立即更新规则
                if (groupId === currentGroupId) {
                    const enabledHeaders = data[groupId]
                        .filter(h => h.enabled && h.name && h.name.trim())
                        .map(h => ({ name: h.name.trim(), value: h.value || '' }));
                    
                    chrome.runtime.sendMessage({
                        type: 'UPDATE_GLOBAL_HEADERS',
                        headers: enabledHeaders
                    });
                }
                
                resolve({
                    success: true,
                    headerId,
                    header: newHeader,
                    groupId,
                    message: `请求头 "${name}" 添加成功`
                });
            });
        });
    });
}

// 更新请求头
async function updateHeader({ groupId, headerId, name, value, enabled }) {
    return new Promise((resolve, reject) => {
        if (!groupId || !headerId) {
            reject(new Error('请求头组ID和请求头ID不能为空'));
            return;
        }
        
        chrome.storage.local.get(['global_headers_data', 'current_headers_group'], (result) => {
            const data = result.global_headers_data || {};
            const currentGroupId = result.current_headers_group;
            
            if (!data[groupId]) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            const headerIndex = data[groupId].findIndex(h => h.id === headerId);
            if (headerIndex === -1) {
                reject(new Error(`未找到请求头: ${headerId}`));
                return;
            }
            
            // 更新请求头
            const header = data[groupId][headerIndex];
            if (name !== undefined) header.name = name.trim();
            if (value !== undefined) header.value = value;
            if (enabled !== undefined) header.enabled = enabled;
            
            chrome.storage.local.set({ global_headers_data: data }, () => {
                // 如果是当前组，立即更新规则
                if (groupId === currentGroupId) {
                    const enabledHeaders = data[groupId]
                        .filter(h => h.enabled && h.name && h.name.trim())
                        .map(h => ({ name: h.name.trim(), value: h.value || '' }));
                    
                    chrome.runtime.sendMessage({
                        type: 'UPDATE_GLOBAL_HEADERS',
                        headers: enabledHeaders
                    });
                }
                
                resolve({
                    success: true,
                    header: data[groupId][headerIndex],
                    message: `请求头已更新`
                });
            });
        });
    });
}

// 删除请求头
async function deleteHeader({ groupId, headerId }) {
    return new Promise((resolve, reject) => {
        if (!groupId || !headerId) {
            reject(new Error('请求头组ID和请求头ID不能为空'));
            return;
        }
        
        chrome.storage.local.get(['global_headers_data', 'current_headers_group'], (result) => {
            const data = result.global_headers_data || {};
            const currentGroupId = result.current_headers_group;
            
            if (!data[groupId]) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            const headerIndex = data[groupId].findIndex(h => h.id === headerId);
            if (headerIndex === -1) {
                reject(new Error(`未找到请求头: ${headerId}`));
                return;
            }
            
            const deletedHeader = data[groupId][headerIndex];
            data[groupId].splice(headerIndex, 1);
            
            chrome.storage.local.set({ global_headers_data: data }, () => {
                // 如果是当前组，立即更新规则
                if (groupId === currentGroupId) {
                    const enabledHeaders = data[groupId]
                        .filter(h => h.enabled && h.name && h.name.trim())
                        .map(h => ({ name: h.name.trim(), value: h.value || '' }));
                    
                    chrome.runtime.sendMessage({
                        type: 'UPDATE_GLOBAL_HEADERS',
                        headers: enabledHeaders
                    });
                }
                
                resolve({
                    success: true,
                    deletedHeader,
                    message: `请求头 "${deletedHeader.name}" 已删除`
                });
            });
        });
    });
}

// 切换请求头启用状态
async function toggleHeader({ groupId, headerId, enabled }) {
    return updateHeader({ groupId, headerId, enabled });
}

// 批量更新请求头（替换整个组的请求头）
async function batchUpdateHeaders({ groupId, headers }) {
    return new Promise((resolve, reject) => {
        if (!groupId) {
            reject(new Error('请求头组ID不能为空'));
            return;
        }
        if (!Array.isArray(headers)) {
            reject(new Error('headers 必须是数组'));
            return;
        }
        
        chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group'], (result) => {
            const groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};
            const currentGroupId = result.current_headers_group;
            
            // 验证组是否存在
            const group = groups.find(g => g.id === groupId);
            if (!group) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            // 替换请求头
            data[groupId] = headers.map((h, index) => ({
                id: h.id || `h_${Date.now()}_${index}`,
                name: (h.name || '').trim(),
                value: h.value || '',
                enabled: h.enabled !== false
            }));
            
            chrome.storage.local.set({ global_headers_data: data }, () => {
                // 如果是当前组，立即更新规则
                if (groupId === currentGroupId) {
                    const enabledHeaders = data[groupId]
                        .filter(h => h.enabled && h.name && h.name.trim())
                        .map(h => ({ name: h.name.trim(), value: h.value || '' }));
                    
                    chrome.runtime.sendMessage({
                        type: 'UPDATE_GLOBAL_HEADERS',
                        headers: enabledHeaders
                    });
                }
                
                resolve({
                    success: true,
                    groupId,
                    headersCount: data[groupId].length,
                    message: `请求头组 "${group.name}" 已更新，共 ${data[groupId].length} 个请求头`
                });
            });
        });
    });
}

// ============== 智能场景协调功能 ==============

// 批量启用脚本
async function batchEnableScripts({ scriptIds, enabled = true, autoRefresh = false }) {
    const tab = await getActiveTab();
    if (!tab || !tab.url) {
        throw new Error('无法获取当前标签页');
    }
    
    const hostname = new URL(tab.url).hostname;
    
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['antidebug_mode', 'global_scripts', hostname], (result) => {
            const mode = result.antidebug_mode || 'standard';
            let currentScripts;
            let storageKey;
            
            if (mode === 'global') {
                currentScripts = result.global_scripts || [];
                storageKey = 'global_scripts';
            } else {
                currentScripts = result[hostname] || [];
                storageKey = hostname;
            }
            
            const enabledBefore = currentScripts.length;
            
            if (enabled) {
                // 添加脚本（去重）
                for (const scriptId of scriptIds) {
                    if (!currentScripts.includes(scriptId)) {
                        currentScripts.push(scriptId);
                    }
                }
            } else {
                // 移除脚本
                currentScripts = currentScripts.filter(id => !scriptIds.includes(id));
            }
            
            chrome.storage.local.set({ [storageKey]: currentScripts }, () => {
                // 通知background更新脚本注册
                chrome.runtime.sendMessage({
                    type: 'update_scripts_registration',
                    hostname: mode === 'global' ? '*' : hostname,
                    enabledScripts: currentScripts,
                    isGlobalMode: mode === 'global'
                });
                
                const result = {
                    success: true,
                    mode,
                    hostname: mode === 'global' ? '*' : hostname,
                    scriptIds,
                    enabled,
                    enabledBefore,
                    enabledAfter: currentScripts.length,
                    currentScripts,
                    message: enabled 
                        ? `已启用 ${scriptIds.length} 个脚本`
                        : `已禁用 ${scriptIds.length} 个脚本`
                };
                
                if (autoRefresh) {
                    // 自动刷新页面
                    chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
                        result.refreshed = true;
                        result.message += '，页面已刷新';
                        resolve(result);
                    });
                } else {
                    result.refreshed = false;
                    result.message += '，刷新页面后生效';
                    resolve(result);
                }
            });
        });
    });
}

// 禁用所有脚本
async function disableAllScripts({ autoRefresh = false } = {}) {
    const tab = await getActiveTab();
    if (!tab || !tab.url) {
        throw new Error('无法获取当前标签页');
    }
    
    const hostname = new URL(tab.url).hostname;
    
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['antidebug_mode', 'global_scripts', hostname], (result) => {
            const mode = result.antidebug_mode || 'standard';
            let storageKey;
            let previousScripts;
            
            if (mode === 'global') {
                previousScripts = result.global_scripts || [];
                storageKey = 'global_scripts';
            } else {
                previousScripts = result[hostname] || [];
                storageKey = hostname;
            }
            
            // 清空脚本列表
            chrome.storage.local.set({ [storageKey]: [] }, () => {
                // 通知background更新脚本注册
                chrome.runtime.sendMessage({
                    type: 'update_scripts_registration',
                    hostname: mode === 'global' ? '*' : hostname,
                    enabledScripts: [],
                    isGlobalMode: mode === 'global'
                });
                
                const resultData = {
                    success: true,
                    mode,
                    hostname: mode === 'global' ? '*' : hostname,
                    previousScripts,
                    disabledCount: previousScripts.length,
                    message: `已禁用 ${previousScripts.length} 个脚本`
                };
                
                if (autoRefresh) {
                    chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
                        resultData.refreshed = true;
                        resultData.message += '，页面已刷新';
                        resolve(resultData);
                    });
                } else {
                    resultData.refreshed = false;
                    resultData.message += '，刷新页面后生效';
                    resolve(resultData);
                }
            });
        });
    });
}

// ============== 导出函数供background.js使用 ==============
// 注意：在Service Worker中，这些函数通过全局作用域访问
self.mcpClient = {
    init: initMCPConnection,
    connect: connectToMCP,
    disconnect: disconnectFromMCP,
    isConnected: () => isConnected,
    addHookData,
    addNetworkRequest
};

// 初始化
initMCPConnection();
