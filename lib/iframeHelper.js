/**
 * iframeHelper.js - iframe 监控功能
 * 
 * 功能：
 * - 获取 Preview iframe
 * - 获取 WS 状态（CONNECTED/IDLE/CONNECTING）
 * - 点击 Connect/Disconnect 按钮
 * - 重连 WS
 * - 关闭 interaction-modal 遮罩层
 * - 诊断 iframe 内容（用于调试）
 */

const fs = require('fs');
const path = require('path');

/**
 * 获取 Preview iframe
 * @param {Page} page - Playwright 页面对象
 * @returns {FrameLocator} iframe 的 FrameLocator
 */
async function getPreviewFrame(page) {
  return page.frameLocator('iframe[title="Preview"]');
}

/**
 * 获取 WS 状态
 * P0-3: 添加 iframe 可见性检查，避免选择器失效
 * @param {Page} page - Playwright 页面对象
 * @param {Object} logger - 日志对象
 * @returns {Promise<string>} WS 状态（CONNECTED/IDLE/CONNECTING/UNKNOWN）
 */
async function getWsStatus(page, logger = null) {
  try {
    // P0-3: 先检查 iframe 是否存在和可见
    const iframeLocator = page.locator('iframe[title="Preview"]');
    const iframeCount = await iframeLocator.count();
    
    if (iframeCount === 0) {
      if (logger) logger.warn('Preview iframe 不存在，无法获取 WS 状态');
      return 'UNKNOWN';
    }
    
    // P0-3: 检查 iframe 是否可见
    const iframeVisible = await iframeLocator.first().isVisible({ timeout: 1000 }).catch(() => false);
    if (!iframeVisible) {
      if (logger) logger.warn('Preview iframe 不可见，无法获取 WS 状态');
      return 'UNKNOWN';
    }
    
    const frame = await getPreviewFrame(page);
    const statusElement = frame.getByText(/WS:\s*(CONNECTED|IDLE|CONNECTING)/i).first();
    
    // 增加超时时间从 3 秒到 5 秒，应对 iframe 内容加载缓慢的情况
    if (await statusElement.isVisible({ timeout: 5000 })) {
      const text = await statusElement.textContent();
      if (text && text.toUpperCase().includes('CONNECTED')) {
        return 'CONNECTED';
      }
      if (text && text.toUpperCase().includes('IDLE')) {
        return 'IDLE';
      }
      if (text && text.toUpperCase().includes('CONNECTING')) {
        return 'CONNECTING';
      }
    } else {
      if (logger) logger.warn('WS 状态元素不可见，可能 UI 已更改');
    }
  } catch (e) {
    if (logger) logger.warn(`获取 WS 状态失败: ${e.message}`);
  }
  return 'UNKNOWN';
}

/**
 * 点击 Disconnect 按钮
 * @param {Page} page - Playwright 页面对象
 * @param {Object} logger - 日志对象
 * @returns {Promise<boolean>} 是否成功点击
 */
async function clickDisconnect(page, logger = null) {
  try {
    const frame = await getPreviewFrame(page);
    const disconnectBtn = frame.locator('button:has-text("Disconnect")');
    
    if (await disconnectBtn.count() > 0 && await disconnectBtn.first().isVisible({ timeout: 3000 })) {
      await disconnectBtn.first().click({ timeout: 5000 });
      if (logger) logger.info('已点击 Disconnect 按钮');
      return true;
    }
  } catch (e) {
    if (logger) logger.warn(`点击 Disconnect 按钮失败: ${e.message}`);
  }
  return false;
}

/**
 * 点击 Connect 按钮
 * @param {Page} page - Playwright 页面对象
 * @param {Object} logger - 日志对象
 * @returns {Promise<boolean>} 是否成功点击
 */
async function clickConnect(page, logger = null) {
  try {
    const frame = await getPreviewFrame(page);
    const connectBtn = frame.locator('button:has-text("Connect")');
    
    if (await connectBtn.count() > 0 && await connectBtn.first().isVisible({ timeout: 3000 })) {
      await connectBtn.first().click({ timeout: 5000 });
      if (logger) logger.info('已点击 Connect 按钮');
      return true;
    }
  } catch (e) {
    if (logger) logger.warn(`点击 Connect 按钮失败: ${e.message}`);
  }
  return false;
}

/**
 * 重连 WS
 * P1-4: 添加重试机制，增强连接稳定性
 * @param {Page} page - Playwright 页面对象
 * @param {Object} logger - 日志对象
 * @param {number} maxRetries - 最大重试次数
 * @returns {Promise<string>} 重连后的 WS 状态
 */
async function reconnectWs(page, logger = null, maxRetries = 3) {
  if (logger) logger.info('开始重连 WS...');
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 点击 Disconnect
      const disconnected = await clickDisconnect(page, logger);
      if (!disconnected && attempt < maxRetries) {
        if (logger) logger.warn(`尝试 ${attempt} 断开失败，重试...`);
        await page.waitForTimeout(2000);
        continue;
      }
      
      await page.waitForTimeout(2000);
      
      // 点击 Connect
      const connected = await clickConnect(page, logger);
      if (!connected && attempt < maxRetries) {
        if (logger) logger.warn(`尝试 ${attempt} 连接失败，重试...`);
        await page.waitForTimeout(2000);
        continue;
      }
      
      await page.waitForTimeout(2000);
      
      // 验证重连成功
      const status = await getWsStatus(page, logger);
      if (status === 'CONNECTED') {
        if (logger) logger.info(`重连成功，WS 状态: ${status}`);
        return status;
      } else if (attempt < maxRetries) {
        if (logger) logger.warn(`第 ${attempt} 次重连后状态未 CONNECTED，将重试`);
      }
    } catch (e) {
      if (logger) logger.warn(`第 ${attempt} 次重连异常: ${e.message}`);
      if (attempt < maxRetries) {
        await page.waitForTimeout(3000);
      }
    }
  }
  
  if (logger) logger.error(`重连失败，经过 ${maxRetries} 次尝试`);
  return 'UNKNOWN';
}

/**
 * 关闭 interaction-modal 遮罩层
 * 通过在 iframe 区域内模拟鼠标移动来触发遮罩层关闭
 * @param {Page} page - Playwright 页面对象
 * @param {Object} logger - 日志对象
 * @returns {Promise<boolean>} 是否成功关闭
 */
async function dismissInteractionModal(page, logger = null) {
  try {
    const modal = page.locator('div.interaction-modal');
    
    // 检查是否存在遮罩层
    if (await modal.count() === 0 || !await modal.first().isVisible({ timeout: 500 })) {
      return false;
    }
    
    if (logger) logger.info('检测到 interaction-modal 遮罩层，尝试关闭...');
    
    const iframe = page.locator('iframe[title="Preview"]');
    const iframeBox = await iframe.first().boundingBox();
    
    if (!iframeBox) {
      if (logger) logger.warn('无法获取 iframe 边界');
      return false;
    }
    
    // 在 iframe 区域内随机移动鼠标 30 次
    let currX = iframeBox.x + 50;
    let currY = iframeBox.y + 50;
    
    for (let i = 0; i < 30; i++) {
      const deltaX = Math.random() * 60 - 30;
      const deltaY = Math.random() * 40 - 20;
      
      currX = Math.max(iframeBox.x + 20, Math.min(iframeBox.x + iframeBox.width - 20, currX + deltaX));
      currY = Math.max(iframeBox.y + 20, Math.min(iframeBox.y + iframeBox.height - 20, currY + deltaY));
      
      await page.mouse.move(currX, currY);
      await page.waitForTimeout(50);
      
      // 检查遮罩层是否已关闭
      if (await modal.count() === 0 || !await modal.first().isVisible({ timeout: 100 })) {
        if (logger) logger.info('interaction-modal 遮罩层已关闭');
        return true;
      }
    }
    
    if (logger) logger.warn('无法关闭 interaction-modal 遮罩层');
  } catch (e) {
    if (logger) logger.warn(`关闭 interaction-modal 失败: ${e.message}`);
  }
  
  return false;
}

/**
 * 诊断 iframe 内容
 * 定期输出 iframe 内的文本内容，用于检测错误或异常
 * @param {Page} page - Playwright 页面对象
 * @param {Object} logger - 日志对象
 * @returns {Promise<void>}
 */
async function diagnosticIframeContent(page, logger = null) {
  try {
    const iframeLocator = page.locator('iframe[title="Preview"]');
    const iframeCount = await iframeLocator.count();
    
    if (iframeCount === 0) {
      if (logger) logger.warn('[诊断] Preview iframe 不存在');
      return;
    }
    
    const frame = await getPreviewFrame(page);
    const content = await frame.textContent().catch(() => null);
    
    if (!content) {
      if (logger) logger.warn('[诊断] 无法获取 iframe 文本内容');
      return;
    }
    
    // 截取前 300 字符用于日志
    const preview = content.substring(0, 300).replace(/\n/g, ' ').trim();
    if (logger) logger.debug(`[诊断] iframe 内容: ${preview}`);
    
    // 检查是否有常见错误提示
    if (content.toLowerCase().includes('error') || 
        content.toLowerCase().includes('failed') || 
        content.toLowerCase().includes('loading')) {
      if (logger) logger.warn(`[诊断] 检测到异常关键词在 iframe 内容中`);
    }
  } catch (e) {
    if (logger) logger.warn(`[诊断] 获取 iframe 内容失败: ${e.message}`);
  }
}

/**
 * 截图诊断
 * 当 iframe 消失或异常时保存截图
 * @param {Page} page - Playwright 页面对象
 * @param {Object} logger - 日志对象
 * @param {string} reason - 截图原因
 * @returns {Promise<void>}
 */
async function saveScreenshot(page, logger = null, reason = '诊断') {
  try {
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `screenshot-${reason}-${timestamp}.png`;
    const filepath = path.join(logsDir, filename);
    
    await page.screenshot({ path: filepath, fullPage: true });
    
    if (logger) logger.info(`[诊断] 已保存截图: ${filename}`);
  } catch (e) {
    if (logger) logger.warn(`[诊断] 保存截图失败: ${e.message}`);
  }
}

module.exports = {
  getPreviewFrame,
  getWsStatus,
  clickDisconnect,
  clickConnect,
  reconnectWs,
  dismissInteractionModal,
  diagnosticIframeContent,
  saveScreenshot
};