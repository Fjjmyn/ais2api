/**
 * unified-server.js - 浏览器自动化管理服务器
 * 
 * 功能：
 * - 管理多个浏览器实例
 * - 监控浏览器状态
 * - 提供健康检查端点
 * - 优雅关闭
 */

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ProcessManager } = require('./lib/processManager');

// ===================================================================================
// AUTH SOURCE MANAGEMENT MODULE
// ===================================================================================
class AuthSource {
  constructor(logger) {
    this.logger = logger;
    this.authMode = "file";
    this.availableIndices = [];
    this.initialIndices = [];
    this.accountNameMap = new Map();

    if (process.env.AUTH_JSON_1) {
      this.authMode = "env";
      this.logger.info(
        "[Auth] 检测到 AUTH_JSON_1 环境变量，切换到环境变量认证模式。"
      );
    } else {
      this.logger.info(
        '[Auth] 未检测到环境变量认证，将使用 "auth/" 目录下的文件。'
      );
    }

    this._discoverAvailableIndices();
    this._preValidateAndFilter();

    if (this.availableIndices.length === 0) {
      this.logger.error(
        `[Auth] 致命错误：在 '${this.authMode}' 模式下未找到任何有效的认证源。`
      );
      throw new Error("No valid authentication sources found.");
    }
  }

  _discoverAvailableIndices() {
    let indices = [];
    if (this.authMode === "env") {
      const regex = /^AUTH_JSON_(\d+)$/;
      for (const key in process.env) {
        const match = key.match(regex);
        if (match && match[1]) {
          indices.push(parseInt(match[1], 10));
        }
      }
    } else {
      const authDir = path.join(__dirname, "auth");
      if (!fs.existsSync(authDir)) {
        this.logger.warn('[Auth] "auth/" 目录不存在。');
        this.availableIndices = [];
        return;
      }
      try {
        const files = fs.readdirSync(authDir);
        const authFiles = files.filter((file) => /^auth-\d+\.json$/.test(file));
        indices = authFiles.map((file) =>
          parseInt(file.match(/^auth-(\d+)\.json$/)[1], 10)
        );
      } catch (error) {
        this.logger.error(`[Auth] 扫描 "auth/" 目录失败: ${error.message}`);
        this.availableIndices = [];
        return;
      }
    }

    this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
    this.availableIndices = [...this.initialIndices];

    this.logger.info(
      `[Auth] 在 '${this.authMode}' 模式下，初步发现 ${
        this.initialIndices.length
      } 个认证源: [${this.initialIndices.join(", ")}]`
    );
  }

  _preValidateAndFilter() {
    if (this.availableIndices.length === 0) return;

    this.logger.info("[Auth] 开始预检验所有认证源的JSON格式...");
    const validIndices = [];
    const invalidSourceDescriptions = [];

    for (const index of this.availableIndices) {
      const authContent = this._getAuthContent(index);
      if (authContent) {
        try {
          const authData = JSON.parse(authContent);
          validIndices.push(index);
          this.accountNameMap.set(
            index,
            authData.accountName || "N/A (未命名)"
          );
        } catch (e) {
          invalidSourceDescriptions.push(`auth-${index}`);
        }
      } else {
        invalidSourceDescriptions.push(`auth-${index} (无法读取)`);
      }
    }

    if (invalidSourceDescriptions.length > 0) {
      this.logger.warn(
        `⚠️ [Auth] 预检验发现 ${
          invalidSourceDescriptions.length
        } 个格式错误或无法读取的认证源: [${invalidSourceDescriptions.join(
          ", "
        )}]，将从可用列表中移除。`
      );
    }

    this.availableIndices = validIndices;
  }

  _getAuthContent(index) {
    if (this.authMode === "env") {
      return process.env[`AUTH_JSON_${index}`];
    } else {
      const authFilePath = path.join(__dirname, "auth", `auth-${index}.json`);
      if (!fs.existsSync(authFilePath)) return null;
      try {
        return fs.readFileSync(authFilePath, "utf-8");
      } catch (e) {
        return null;
      }
    }
  }

  getAuth(index) {
    if (!this.availableIndices.includes(index)) {
      this.logger.error(`[Auth] 请求了无效或不存在的认证索引: ${index}`);
      return null;
    }

    let jsonString = this._getAuthContent(index);
    if (!jsonString) {
      this.logger.error(`[Auth] 在读取时无法获取认证源 #${index} 的内容。`);
      return null;
    }

    try {
      return JSON.parse(jsonString);
    } catch (e) {
      this.logger.error(
        `[Auth] 解析来自认证源 #${index} 的JSON内容失败: ${e.message}`
      );
      return null;
    }
  }
}

// ===================================================================================
// BROWSER AUTOMATION SERVER
// ===================================================================================
class BrowserAutomationServer {
  constructor() {
    this.logger = console;
    this._loadConfiguration();
    this.authSource = new AuthSource(this.logger);
    this.processManager = new ProcessManager(this.logger);
    this.httpServer = null;
    this.shutdownEvent = { isSet: () => false };
  }

  _loadConfiguration() {
    this.config = {
      httpPort: parseInt(process.env.PORT, 10) || 7860,
      host: process.env.HOST || "0.0.0.0",
      instanceUrl: process.env.CAMOUFOX_INSTANCE_URL,
      headless: process.env.CAMOUFOX_HEADLESS !== 'false',
      proxy: process.env.CAMOUFOX_PROXY,
      startDelay: parseInt(process.env.INSTANCE_START_DELAY, 10) || 30,
    };

    if (!this.config.instanceUrl) {
      this.logger.error("错误: 缺少环境变量 CAMOUFOX_INSTANCE_URL");
      throw new Error("Missing required environment variable: CAMOUFOX_INSTANCE_URL");
    }

    this.logger.info("================ [ 生效配置 ] ================");
    this.logger.info(`  HTTP 服务端口: ${this.config.httpPort}`);
    this.logger.info(`  监听地址: ${this.config.host}`);
    this.logger.info(`  实例 URL: ${this.config.instanceUrl}`);
    this.logger.info(`  无头模式: ${this.config.headless}`);
    this.logger.info(`  代理: ${this.config.proxy || '未设置'}`);
    this.logger.info(`  启动延迟: ${this.config.startDelay} 秒`);
    this.logger.info("=============================================================");
  }

  _loadInstanceConfigurations() {
    const instances = [];
    
    for (const index of this.authSource.availableIndices) {
      instances.push({
        instanceUrl: this.config.instanceUrl,
        headless: this.config.headless,
        proxy: this.config.proxy,
        authSource: {
          type: this.authSource.authMode,
          identifier: `AUTH_JSON_${index}`,
          display_name: `AUTH_JSON_${index}`,
          index: index
        }
      });
    }
    
    return instances;
  }

  async _startBrowserInstances() {
    const instances = this._loadInstanceConfigurations();
    if (!instances || instances.length === 0) {
      this.logger.error('错误: 无法加载实例配置');
      return;
    }

    this.logger.info(`将启动 ${instances.length} 个浏览器实例`);

    for (let i = 0; i < instances.length; i++) {
      if (this.shutdownEvent.isSet()) break;

      const config = instances[i];
      this.logger.info(`正在启动第 ${i + 1}/${instances.length} 个浏览器实例 (${config.authSource.display_name})...`);

      try {
        const process = this.processManager.spawnBrowserInstance(config);
        
        // 等待配置的时间
        await new Promise(resolve => setTimeout(resolve, this.config.startDelay * 1000));
      } catch (error) {
        this.logger.error(`启动浏览器实例失败: ${error.message}`);
      }
    }

    // 等待所有进程
    while (!this.shutdownEvent.isSet()) {
      const aliveCount = this.processManager.getAliveCount();
      this.logger.info(`当前运行的浏览器实例数: ${aliveCount}`);

      if (aliveCount === 0) {
        this.logger.info('所有浏览器进程已结束，主进程即将退出');
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  _createExpressApp() {
    const app = express();

    // CORS 中间件
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, PATCH, OPTIONS"
      );
      res.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, x-requested-with, x-api-key, x-goog-api-key, origin, accept"
      );
      if (req.method === "OPTIONS") {
        return res.sendStatus(204);
      }
      next();
    });

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // 健康检查端点
    app.get('/health', (req, res) => {
      const runningCount = this.processManager.getAliveCount();
      const totalCount = this.processManager.getCount();
      const processInfo = this.processManager.getProcessInfo();

      res.json({
        status: 'healthy',
        browser_instances: totalCount,
        running_instances: runningCount,
        message: `Application is running with ${runningCount} active browser instances`,
        processes: processInfo
      });
    });

    // 主页端点
    app.get('/', (req, res) => {
      const runningCount = this.processManager.getAliveCount();
      const totalCount = this.processManager.getCount();
      const processInfo = this.processManager.getProcessInfo();
      const logs = [];

      const statusHtml = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>浏览器自动化管理器</title>
        <style>
        body { font-family: 'SF Mono', 'Consolas', 'Menlo', monospace; background-color: #f0f2f5; color: #333; padding: 2em; }
        .container { max-width: 800px; margin: 0 auto; background: #fff; padding: 1em 2em 2em 2em; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        h1, h2 { color: #333; border-bottom: 2px solid #eee; padding-bottom: 0.5em;}
        pre { background: #2d2d2d; color: #f0f0f0; font-size: 1.1em; padding: 1.5em; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.6; }
        .status-ok { color: #2ecc71; font-weight: bold; }
        .status-error { color: #e74c3c; font-weight: bold; }
        .label { display: inline-block; width: 220px; box-sizing: border-box; }
        .dot { height: 10px; width: 10px; background-color: #bbb; border-radius: 50%; display: inline-block; margin-left: 10px; animation: blink 1s infinite alternate; }
        @keyframes blink { from { opacity: 0.3; } to { opacity: 1; } }
        </style>
    </head>
    <body>
        <div class="container">
        <h1>浏览器自动化管理器 <span class="dot" title="数据动态刷新中..."></span></h1>
        <div id="status-section">
            <pre>
<span class="label">服务状态</span>: <span class="status-ok">Running</span>
<span class="label">总实例数</span>: ${totalCount}
<span class="label">运行中的实例</span>: ${runningCount}
--- 配置信息 ---
<span class="label">实例 URL</span>: ${this.config.instanceUrl}
<span class="label">无头模式</span>: ${this.config.headless ? '已启用' : '已禁用'}
<span class="label">代理</span>: ${this.config.proxy || '未设置'}
--- 进程状态 ---
${processInfo.map(p => `<span class="label">${p.display_name}</span>: ${p.is_alive ? '运行中' : '已停止'} (运行时间: ${p.uptime_formatted})`).join('\n')}
            </pre>
        </div>
        </div>
        <script>
        function updateContent() {
            fetch('/health').then(response => response.json()).then(data => {
                const statusPre = document.querySelector('#status-section pre');
                const processStatus = data.processes.map(p => 
                    `<span class="label">${p.display_name}</span>: ${p.is_alive ? '运行中' : '已停止'} (运行时间: ${p.uptime_formatted})`
                ).join('\n');
                statusPre.innerHTML = 
                    '<span class="label">服务状态</span>: <span class="status-ok">Running</span>\n' +
                    '<span class="label">总实例数</span>: ' + data.browser_instances + '\n' +
                    '<span class="label">运行中的实例</span>: ' + data.running_instances + '\n' +
                    '--- 配置信息 ---\n' +
                    '<span class="label">实例 URL</span>: ' + '${this.config.instanceUrl}' + '\n' +
                    '<span class="label">无头模式</span>: ' + (${this.config.headless} ? '已启用' : '已禁用') + '\n' +
                    '<span class="label">代理</span>: ' + ('${this.config.proxy}' || '未设置') + '\n' +
                    '--- 进程状态 ---\n' +
                    processStatus;
            }).catch(error => console.error('Error fetching new content:', error));
        }

        document.addEventListener('DOMContentLoaded', () => {
            updateContent(); 
            setInterval(updateContent, 5000);
        });
        </script>
    </body>
    </html>
    `;
      res.status(200).send(statusHtml);
    });

    return app;
  }

  async start() {
    this.logger.info("[System] 开始启动浏览器自动化管理器...");

    // 启动 HTTP 服务器
    await this._startHttpServer();

    // 在后台启动浏览器实例
    this._startBrowserInstances().catch(err => {
      this.logger.error('启动浏览器实例失败:', err);
    });
  }

  async _startHttpServer() {
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);

    this.httpServer.keepAliveTimeout = 120000;
    this.httpServer.headersTimeout = 125000;
    this.httpServer.requestTimeout = 120000;

    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(
          `[System] HTTP服务器已在 http://${this.config.host}:${this.config.httpPort} 上监听`
        );
        this.logger.info(
          `[System] 健康检查端点: http://${this.config.host}:${this.config.httpPort}/health`
        );
        resolve();
      });
    });
  }

  async stop() {
    this.logger.info("[System] 正在停止浏览器自动化管理器...");
    this.shutdownEvent.isSet = () => true;
    await this.processManager.terminateAll();
    
    if (this.httpServer) {
      this.httpServer.close();
    }
    
    this.logger.info("[System] 浏览器自动化管理器已停止");
  }
}

// ===================================================================================
// MAIN INITIALIZATION
// ===================================================================================
async function initializeServer() {
  const server = new BrowserAutomationServer();

  // 信号处理
  process.on('SIGTERM', async () => {
    console.log('接收到 SIGTERM 信号，正在关闭...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('接收到 SIGINT 信号，正在关闭...');
    await server.stop();
    process.exit(0);
  });

  try {
    await server.start();
  } catch (error) {
    console.error("❌ 服务器启动失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  initializeServer();
}

module.exports = { BrowserAutomationServer, initializeServer };