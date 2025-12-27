/**
 * browserInstance.js - 浏览器实例管理
 * 
 * 功能：
 * - 启动浏览器实例
 * - 加载 Cookie
 * - 导航到目标 URL
 * - 处理弹窗
 * - 启动保活循环
 */

const { firefox } = require('playwright');
const { handlePopupDialog, startKeepAliveLoop } = require('./keepAlive');

/**
 * 保活错误类
 */
class KeepAliveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeepAliveError';
  }
}

/**
 * 加载 Cookie
 * @param {Object} authSource - 认证源对象
 * @returns {Promise<Array>} Cookie 数组
 */
async function loadCookies(authSource) {
  if (!authSource.cookies || !Array.isArray(authSource.cookies)) {
    console.error(`[${authSource.display_name}] 没有 Cookie 数据`);
    return [];
  }

  console.log(`[${authSource.display_name}] 加载 ${authSource.cookies.length} 个 Cookie`);
  return authSource.cookies;
}

/**
 * 运行浏览器实例
 * @param {Object} config - 配置对象
 * @param {Object} shutdownEvent - 关闭事件对象
 * @returns {Promise<void>}
 */
async function runBrowserInstance(config, shutdownEvent = null) {
  const { authSource, instanceUrl, headless = true, proxy } = config;
  
  const instanceLabel = authSource.display_name || 'Unknown';
  
  const logger = {
    info: (msg) => console.log(`[${instanceLabel}] INFO: ${msg}`),
    warn: (msg) => console.warn(`[${instanceLabel}] WARN: ${msg}`),
    error: (msg) => console.error(`[${instanceLabel}] ERROR: ${msg}`),
    debug: (msg) => console.log(`[${instanceLabel}] DEBUG: ${msg}`)
  };
  
  logger.info('启动浏览器实例...');
  
  // 加载 Cookie
  const cookies = await loadCookies(authSource);
  if (!cookies || cookies.length === 0) {
    logger.error('没有可用的 Cookie');
    return;
  }
  
  logger.info(`已加载 ${cookies.length} 个 Cookie`);
  
  // 启动浏览器（使用 Camoufox，原项目配置）
  const launchOptions = {
    headless: headless ? 'virtual' : false,
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--safebrowsing-disable-auto-update'
    ]
  };
  
  // Camoufox 可执行文件路径
  const platform = process.platform;
  let browserExecutablePath;
  
  if (platform === 'linux') {
    browserExecutablePath = path.join(__dirname, 'camoufox-linux', 'camoufox');
  } else if (platform === 'win32') {
    browserExecutablePath = path.join(__dirname, 'camoufox', 'camoufox.exe');
  } else {
    throw new Error(`Unsupported operating system: ${platform}`);
  }
  
  if (browserExecutablePath) {
    launchOptions.executablePath = browserExecutablePath;
    logger.info(`使用 Camoufox: ${browserExecutablePath}`);
  }
  
  if (proxy) {
    launchOptions.proxy = { server: proxy, bypass: 'localhost, 127.0.1' };
    logger.info(`使用代理: ${proxy}`);
  }
  
  let browser;
  let context;
  let page;
  
  try {
    logger.info('正在启动 Camoufox 浏览器...');
    browser = await firefox.launch(launchOptions);
    context = await browser.newContext();
    await context.addCookies(cookies);
    page = await context.newPage();
    
    // 导航到目标 URL
    logger.info(`正在导航到: ${instanceUrl}`);
    await page.goto(instanceUrl, { timeout: 90000, waitUntil: 'domcontentloaded' });
    
    // 检查 URL 验证
    const finalUrl = page.url();
    if (finalUrl.includes('accounts.google.com')) {
      logger.error('检测到 Google 登录页面，Cookie 已失效');
      throw new KeepAliveError('Cookie 已失效');
    }
    
    logger.info(`成功导航到: ${finalUrl}`);
    
    // 等待页面加载完成
    await page.waitForTimeout(2000);
    
    // 处理弹窗
    logger.info('处理弹窗...');
    const handled = await handlePopupDialog(page, logger);
    if (handled) {
      logger.info('已处理弹窗');
    }
    
    // 启动保活循环
    logger.info('启动保活循环...');
    await startKeepAliveLoop(page, logger, shutdownEvent);
    
  } catch (e) {
    if (e instanceof KeepAliveError) {
      logger.error(`保活错误: ${e.message}`);
    } else {
      logger.error(`浏览器实例错误: ${e.message}`);
      logger.error(e.stack);
    }
  } finally {
    // 关闭浏览器
    if (page) {
      try {
        await page.close();
      } catch (e) {
        logger.warn(`关闭页面失败: ${e.message}`);
      }
    }
    
    if (context) {
      try {
        await context.close();
      } catch (e) {
        logger.warn(`关闭上下文失败: ${e.message}`);
      }
    }
    
    if (browser) {
      try {
        await browser.close();
        logger.info('浏览器实例已关闭');
      } catch (e) {
        logger.warn(`关闭浏览器失败: ${e.message}`);
      }
    }
  }
}

/**
 * 从命令行参数加载配置
 * @returns {Object} 配置对象
 */
function loadConfigFromArgs() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('错误: 缺少配置参数');
    process.exit(1);
  }
  
  try {
    const config = JSON.parse(args[0]);
    return config;
  } catch (e) {
    console.error('错误: 无法解析配置参数');
    console.error(e.message);
    process.exit(1);
  }
}

// 如果作为独立进程运行
if (require.main === module) {
  const config = loadConfigFromArgs();
  const shutdownEvent = { isSet: () => false };
  
  // 监听关闭信号
  process.on('SIGTERM', () => {
    console.log(`[${config.authSource.display_name}] 接收到 SIGTERM 信号`);
    shutdownEvent.isSet = () => true;
  });
  
  process.on('SIGINT', () => {
    console.log(`[${config.authSource.display_name}] 接收到 SIGINT 信号`);
    shutdownEvent.isSet = () => true;
  });
  
  runBrowserInstance(config, shutdownEvent).catch(err => {
    console.error(`[${config.authSource.display_name}] 启动失败:`, err);
    process.exit(1);
  });
}

module.exports = {
  runBrowserInstance,
  KeepAliveError
};