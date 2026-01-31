// ==UserScript==
// @name         Genius 现货自动交易
// @namespace    https://www.tradegenius.com
// @version      3.11.6
// @description  Genius 现货自动交易 - 支持自定义交易对
// @author       You
// @match        https://www.tradegenius.com/*
// @grant        GM_xmlhttpRequest
// @connect      www.tradegenius.com
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/SS168-ccs/GoodJob/main/trade-automation-v2.user.js
// @downloadURL  https://raw.githubusercontent.com/SS168-ccs/GoodJob/main/trade-automation-v2.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // 防止在 iframe 中重复运行
    if (window.top !== window.self) return;

    // UI 显示版本：从 Tampermonkey 解析的 @version 读取，只需维护头部 @version 一处
    const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version)
        ? GM_info.script.version
        : '3.11.0';

    // ==================== 配置参数 ====================
    const CONFIG = {
        // 延迟设置（毫秒）- 使用不规则随机数
        waitAfterChoose: [835, 1539],
        waitAfterClick: [523, 987],       // 点击后等待
        waitAfterTokenSelect: [1287, 2143],
        waitAfterSaved: [1156, 1987],
        waitAfterMax: [923, 1567],
        waitBeforeConfirm: [963, 1315],
        waitAfterConfirm: [2876, 4231],
        waitAfterClose: [1324, 1987],
        
        // 交易间隔
        waitBetweenRounds: [5234, 8456], // 5-8秒
        
        // 重试设置
        maxRetryToken: 3,
        
        // UI 稳定等待时间
        UI_STABLE_WAIT: 500,              // UI 稳定等待时间（毫秒）
        LOG_MAX_CHARS: 2000,              // 面板日志最多保留字符数
        
        // 超时设置
        DIALOG_OPEN_TIMEOUT: 5000,        // 弹窗打开超时（毫秒）
        DIALOG_CLOSE_TIMEOUT: 5000,       // 弹窗关闭超时（毫秒）
        TOKEN_LIST_APPEAR_TIMEOUT: 10000, // 代币列表/名字格出现超时（第一个、第二个 Choose）
        TOKEN_LIST_WAIT: [1000, 1500],    // 代币列表等待时间（毫秒）
        OBSERVATION_PERIOD: 1500,         // Confirm 按钮观察期（毫秒）
        CONFIRM_WAIT_TIMEOUT: 30000,      // Confirm 按钮等待超时（毫秒）
        FIRST_DIALOG_OPEN_TIMEOUT: 8000,  // 首次打开交易弹窗超时（executeSwapLoop）
        CHAIN_SEARCH_TIMEOUT: 5000,       // 全页找链按钮超时（selectTokenWithChain fallback）
        DIALOG_CLOSE_RETRY_WAIT: 3000,    // 弹窗未关闭时重试等待（selectToken 内）
        TAB_ACTIVATE_TIMEOUT: 5000,       // Saved/Stable 标签激活超时（clickTab）
        PRICE_LOAD_TIMEOUT: 10000,        // 价格元素加载超时（waitForPrices / 滑点保护）
        
        // 轮询与最小等待
        POLL_INTERVAL: 200,               // waitFor* 内轮询间隔（毫秒）
        MIN_SLEEP_MS: 200,                // randomSleep 最少等待（毫秒）
        
        // 其他等待时间
        CLOSE_DIALOG_WAIT: 2000,          // 关闭弹窗等待时间（毫秒）
        RETRY_WAIT: 3000,                 // 重试等待时间（毫秒）
        PAGE_NAVIGATE_WAIT: 2000,         // 页面导航等待时间（毫秒）
        VOLUME_FETCH_TIMEOUT: 15000,      // 获取交易额 iframe 超时（毫秒）
        REFRESH_WAIT_MS: [3000, 5000]     // 点击 Refresh 后等待报价刷新（毫秒）
    };

    // ==================== 全局变量 ====================
    let isRunning = false;
    let isDeployRunning = false;   // 新号一键部署独立状态，与 isRunning 无关
    let todayTradeTarget = 0;      // 今日交易目标
    let consecutiveFailures = 0;   // 连续失败次数
    const MAX_CONSECUTIVE_FAILURES = 3; // 最大连续失败次数
    
    // 速率倍数（1x, 3x, 5x）
    let speedMultiplier = 1;
    
    // 交易代币对（两个代币都可以自定义）
    let baseToken = 'USDC';        // 基础币种（可替换）
    let targetToken = 'KOGE';      // 目标代币（可替换）
    
    // 链与原生代币常量（单一来源：新增链或 Gas 代币只改此处）
    const CHAIN_OPTIONS = ['BNB', 'Optimism', 'Base', 'Arbitrum', 'Polygon', 'Solana'];
    let baseChain = 'BNB';         // 基础币种使用的链
    let targetChain = 'BNB';       // 目标代币使用的链
    // 由「是否选择目标链」决定是否在 Stable 中选目标代币（目标链有值即启用）
    const NATIVE_TOKENS = ['BNB', 'SOL', 'ETH', 'AVAX', 'HYPE', 'SUI', 'POL', 'S']; // Gas 框中查找
    const ETH_CHAINS = ['Base', 'Optimism', 'Arbitrum', 'Ethereum'];
    
    // 每日限额设置
    let enableDailyLimit = true;   // 是否启用每日限额
    let dailyLimitMin = 53;        // 最小限额
    let dailyLimitMax = 108;       // 最大限额
    
    // 交易额限制设置
    let enableVolumeLimit = false;  // 是否启用交易额限制
    let volumeLimitTarget = 100000; // 交易额目标（美元）
    let currentVolume = 0;          // 当前交易额
    let lastVolumeCheck = 0;        // 上次检查时间
    
    // 金额选项设置（用于随机选择）
    let amountOptions = {
        'MAX': true,
        '50%': true,
        '25%': true
    };
    
    // 滑点保护设置
    let enableSlippageProtection = true;  // 是否启用滑点保护
    let maxSlippagePercent = 0.05;        // 最大允许滑点百分比（默认万分之五）
    
    let stats = {
        successfulSwaps: 0,
        failedSwaps: 0,
        startTime: null,
        todayDate: null
    };
    
    // ==================== 持久化存储 ====================
    
    // 保存所有设置
    const saveAllSettings = () => {
        try {
            const data = {
                // 限额设置
                enableDailyLimit,
                dailyLimitMin,
                dailyLimitMax,
                // 交易额设置
                enableVolumeLimit,
                volumeLimitTarget,
                // 代币设置
                baseToken,
                targetToken,
                // 链设置
                baseChain,
                targetChain,
                // 速率设置
                speedMultiplier,
                // 金额选项
                amountOptions,
                // 滑点保护
                enableSlippageProtection,
                maxSlippagePercent
            };
            localStorage.setItem('tradegenius_settings', JSON.stringify(data));
        } catch (e) {}
    };
    
    // 加载所有设置
    const loadAllSettings = () => {
        try {
            const saved = localStorage.getItem('tradegenius_settings');
            if (saved) {
                const data = JSON.parse(saved);
                // 限额设置
                enableDailyLimit = data.enableDailyLimit !== false;
                dailyLimitMin = data.dailyLimitMin || 53;
                dailyLimitMax = data.dailyLimitMax || 108;
                // 交易额设置
                enableVolumeLimit = data.enableVolumeLimit || false;
                volumeLimitTarget = data.volumeLimitTarget || 100000;
                // 代币设置
                baseToken = data.baseToken || 'USDC';
                targetToken = data.targetToken || 'KOGE';
                // 链设置
                baseChain = data.baseChain || data.usdcChain || 'BNB'; // 兼容旧版本 usdcChain
                // 兼容旧版本：如果没有 baseToken，使用默认 USDC
                if (!data.baseToken && data.targetToken) {
                    baseToken = 'USDC';
                }
                targetChain = data.targetChain || 'BNB';
                // 速率设置 (有效值: 1, 5, 10)
                const savedSpeed = data.speedMultiplier || 1;
                speedMultiplier = [1, 5, 10].includes(savedSpeed) ? savedSpeed : 1;
                // 金额选项
                if (data.amountOptions) {
                    amountOptions = data.amountOptions;
                }
                // 滑点保护
                if (data.enableSlippageProtection !== undefined) {
                    enableSlippageProtection = data.enableSlippageProtection;
                }
                if (data.maxSlippagePercent !== undefined) {
                    maxSlippagePercent = data.maxSlippagePercent;
                }
                return true;
            }
        } catch (e) {}
        return false;
    };
    
    // 获取当前配置快照（与 saveAllSettings 结构一致，用于预设）
    const getCurrentSettings = () => ({
        enableDailyLimit,
        dailyLimitMin,
        dailyLimitMax,
        enableVolumeLimit,
        volumeLimitTarget,
        baseToken,
        targetToken,
        baseChain,
        targetChain,
        speedMultiplier,
        amountOptions: { ...amountOptions },
        enableSlippageProtection,
        maxSlippagePercent
    });
    
    // 预设显示名称（与 预设123.MD 一致）
    const PRESET_NAMES = { 1: 'OP UU', 2: 'FIGHT BSC', 3: 'KOGE' };
    // 预设 1/2/3 内置默认参数（无保存数据时加载）
    const DEFAULT_PRESETS = {
        1: { // OP UU：1X，不勾每日限额，MAX，USDC-USDT，基础链OP目标链OP，交易额12000，滑点0.08%
            enableDailyLimit: false, dailyLimitMin: 53, dailyLimitMax: 108,
            enableVolumeLimit: true, volumeLimitTarget: 12000,
            baseToken: 'USDC', targetToken: 'USDT', baseChain: 'Optimism', targetChain: 'Optimism',
            speedMultiplier: 1, amountOptions: { '25%': false, '50%': false, 'MAX': true },
            enableSlippageProtection: true, maxSlippagePercent: 0.08
        },
        2: { // FIGHT BSC：1X，每日限额2-2，50%，USDC-FIGHT，基础链OP目标链BSC，交易额不勾，滑点0.8%
            enableDailyLimit: true, dailyLimitMin: 2, dailyLimitMax: 2,
            enableVolumeLimit: false, volumeLimitTarget: 100000,
            baseToken: 'USDC', targetToken: 'FIGHT', baseChain: 'Optimism', targetChain: 'BNB',
            speedMultiplier: 1, amountOptions: { '25%': false, '50%': true, 'MAX': false },
            enableSlippageProtection: true, maxSlippagePercent: 0.8
        },
        3: { // KOGE：1X，不勾每日限额，MAX，USDC-KOGE，基础链BSC目标链BSC，交易额100000，滑点0.08%
            enableDailyLimit: false, dailyLimitMin: 53, dailyLimitMax: 108,
            enableVolumeLimit: true, volumeLimitTarget: 100000,
            baseToken: 'USDC', targetToken: 'KOGE', baseChain: 'BNB', targetChain: 'BNB',
            speedMultiplier: 1, amountOptions: { '25%': false, '50%': false, 'MAX': true },
            enableSlippageProtection: true, maxSlippagePercent: 0.08
        }
    };

    // 预设槽位 1/2/3：保存当前配置到指定槽位
    const savePreset = (slot) => {
        try {
            const key = 'tradegenius_preset_' + slot;
            localStorage.setItem(key, JSON.stringify(getCurrentSettings()));
            return true;
        } catch (e) { return false; }
    };

    // 预设槽位 1/2/3：直接应用内置配置（不读已保存数据），写入 tradegenius_settings 后刷新页面
    const loadPreset = (slot) => {
        try {
            const config = DEFAULT_PRESETS[slot];
            if (!config) return false;
            localStorage.setItem('tradegenius_settings', JSON.stringify(config));
            return true;
        } catch (e) { return false; }
    };
    
    const saveStats = () => {
        try {
            const data = {
                todayDate: stats.todayDate,
                successfulSwaps: stats.successfulSwaps,
                failedSwaps: stats.failedSwaps,
                todayTradeTarget: todayTradeTarget
            };
            localStorage.setItem('tradegenius_stats', JSON.stringify(data));
        } catch (e) {
            console.error('保存统计失败:', e);
        }
    };
    
    const loadStats = () => {
        try {
            const saved = localStorage.getItem('tradegenius_stats');
            if (saved) {
                const data = JSON.parse(saved);
                const today = new Date().toDateString();
                // 只加载当天的数据
                if (data.todayDate === today) {
                    stats.todayDate = data.todayDate;
                    stats.successfulSwaps = data.successfulSwaps || 0;
                    stats.failedSwaps = data.failedSwaps || 0;
                    todayTradeTarget = data.todayTradeTarget != null ? data.todayTradeTarget : randomInt(dailyLimitMin, dailyLimitMax);
                    // 启用每日限额时：若今日已完成 ≥ 限额下限，视为「在已有基础上再跑」，目标 = 已完成 + 随机追加笔数
                    if (enableDailyLimit) {
                        if (stats.successfulSwaps >= dailyLimitMin) {
                            const add = randomInt(dailyLimitMin, dailyLimitMax);
                            todayTradeTarget = stats.successfulSwaps + add;
                            log(`📂 今日已完成 ${stats.successfulSwaps} 笔 ≥ 限额下限，目标设为再跑 ${add} 笔 → ${todayTradeTarget} 笔`, 'info');
                        } else if (todayTradeTarget < dailyLimitMin || todayTradeTarget > dailyLimitMax) {
                            todayTradeTarget = randomInt(dailyLimitMin, dailyLimitMax);
                            log(`📂 今日目标已按限额范围重设: ${todayTradeTarget} 笔 (${dailyLimitMin}~${dailyLimitMax})`, 'info');
                        }
                    }
                    log(`📂 已加载今日数据: ${stats.successfulSwaps}/${todayTradeTarget} 笔`, 'info');
                    return true;
                }
            }
        } catch (e) {
            console.error('加载统计失败:', e);
        }
        return false;
    };

    // ==================== 工具函数 ====================
    
    // 检查运行状态
    const checkRunning = () => {
        return isRunning;
    };
    
    // 随机整数
    const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    
    // 可中断的 sleep 函数
    const sleep = (ms) => new Promise(resolve => {
        const checkInterval = 100;
        let elapsed = 0;
        const check = () => {
            if (!isRunning || elapsed >= ms) {
                resolve();
                return;
            }
            elapsed += checkInterval;
            setTimeout(check, checkInterval);
        };
        if (ms <= checkInterval) {
            setTimeout(resolve, ms);
        } else {
            check();
        }
    });

    // 普通随机延迟（受速率倍数影响）
    const randomSleep = async (minMax) => {
        const [min, max] = minMax;
        const wait = Math.floor(Math.random() * (max - min + 1)) + min;
        // 根据速率倍数缩短等待时间
        const adjustedWait = Math.floor(wait / speedMultiplier);
        await sleep(Math.max(adjustedWait, CONFIG.MIN_SLEEP_MS));
    };
    
    // 固定延迟（不受速率影响，用于 Confirm 等关键操作）
    const fixedRandomSleep = async (minMax) => {
        const [min, max] = minMax;
        const wait = Math.floor(Math.random() * (max - min + 1)) + min;
        await sleep(wait);
    };

    const log = (msg, type = 'info') => {
        const time = new Date().toLocaleTimeString();
        const prefix = `[${time}]`;

        const colors = {
            info: '#3b82f6',
            success: '#10b981',
            error: '#ef4444',
            warning: '#f59e0b'
        };

        console.log(`%c${prefix} ${msg}`, `color: ${colors[type]}; font-weight: bold`);

        if (UI.logEl) {
            UI.logEl.textContent = `${prefix} ${msg}\n` + UI.logEl.textContent.slice(0, CONFIG.LOG_MAX_CHARS);
        }
    };
    
    // 初始化每日统计
    const initDailyStats = () => {
        const today = new Date().toDateString();
        
        if (stats.todayDate !== today) {
            if (!loadStats()) {
                stats.todayDate = today;
                stats.successfulSwaps = 0;
                stats.failedSwaps = 0;
                if (enableDailyLimit) {
                    todayTradeTarget = randomInt(dailyLimitMin, dailyLimitMax);
                    log(`📅 新的一天！今日交易目标: ${todayTradeTarget} 笔`, 'info');
                } else {
                    todayTradeTarget = 999999;
                    log(`📅 新的一天！无限额模式`, 'info');
                }
                saveStats();
            }
        }
        consecutiveFailures = 0;
    };
    
    // 检查是否达到每日限额
    const checkDailyLimit = () => {
        if (!enableDailyLimit) return false; // 无限制模式
        if (stats.successfulSwaps >= todayTradeTarget) {
            log(`🎯 已达到今日交易目标 (${todayTradeTarget} 笔)，自动停止`, 'success');
            return true;
        }
        return false;
    };
    
    // 扩展每日限额（用户手动重启时调用）
    const extendDailyLimit = () => {
        if (!enableDailyLimit) return; // 无限制模式不需要扩展
        const additionalTarget = randomInt(dailyLimitMin, dailyLimitMax);
        const oldTarget = todayTradeTarget;
        todayTradeTarget += additionalTarget;
        log(`📈 扩展交易目标: ${oldTarget} → ${todayTradeTarget} (+${additionalTarget} 笔)`, 'success');
        saveStats();
    };
    
    // 从金额选项中随机选择（只从用户选中的选项中选）
    const selectAmount = () => {
        const enabledAmounts = Object.keys(amountOptions).filter(k => amountOptions[k]);
        if (enabledAmounts.length === 0) {
            return 'MAX'; // 默认 MAX
        }
        return enabledAmounts[randomInt(0, enabledAmounts.length - 1)];
    };

    // 正确的交易页面 URL
    const TRADE_PAGE_URL = 'https://www.tradegenius.com/trade';
    const POINTS_PAGE_URL = 'https://www.tradegenius.com/points/you';
    
    // 获取当前交易额（通过 iframe 加载 points 页面，等待渲染后读取）
    const fetchCurrentVolume = () => {
        return new Promise((resolve) => {
            log('📊 正在获取交易额...', 'info');
            
            // 创建隐藏的 iframe
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position: fixed; top: -9999px; left: -9999px; width: 1px; height: 1px; opacity: 0; pointer-events: none;';
            iframe.src = POINTS_PAGE_URL;
            
            let resolved = false;
            const cleanup = () => {
                if (iframe.parentNode) {
                    iframe.parentNode.removeChild(iframe);
                }
            };
            
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    log('⚠️ 获取交易额超时', 'warning');
                    cleanup();
                    resolve(null);
                }
            }, CONFIG.VOLUME_FETCH_TIMEOUT);
            
            // iframe 加载完成后尝试读取
            iframe.onload = () => {
                // 等待客户端渲染完成（多次尝试）
                let attempts = 0;
                const maxAttempts = 10;
                
                const tryRead = () => {
                    attempts++;
                    try {
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                        if (!iframeDoc) {
                            if (attempts < maxAttempts) {
                                setTimeout(tryRead, 500);
                                return;
                            }
                            throw new Error('无法访问 iframe 内容');
                        }
                        
                        // 查找交易额 - 方法1: 新结构 Total Volume + 下方 $ 金额
                        // <div class="flex flex-col items-center gap-2">
                        //   <div class="text-genius-pink ...">Total Volume</div>
                        //   <div class="text-3xl font-medium">$541,779.66</div>
                        // </div>
                        const totalVolumeLabel = Array.from(iframeDoc.querySelectorAll('div')).find(
                            d => (d.textContent || '').trim() === 'Total Volume'
                        );
                        if (totalVolumeLabel && totalVolumeLabel.parentElement) {
                            const container = totalVolumeLabel.parentElement;
                            const amountDiv = container.querySelector('div.text-3xl.font-medium') ||
                                Array.from(container.querySelectorAll('div')).find(
                                    d => /^\$[\d,]+\.?\d*$/.test((d.textContent || '').trim())
                                );
                            if (amountDiv) {
                                const match = (amountDiv.textContent || '').trim().match(/\$[\d,]+\.?\d*/);
                                if (match) {
                                    const volumeStr = match[0].replace(/[$,]/g, '');
                                    const volume = parseFloat(volumeStr);
                                    if (!isNaN(volume) && volume > 0) {
                                        if (!resolved) {
                                            resolved = true;
                                            clearTimeout(timeout);
                                            currentVolume = volume;
                                            lastVolumeCheck = Date.now();
                                            log(`📊 当前交易额: $${volume.toLocaleString()}`, 'success');
                                            cleanup();
                                            resolve(volume);
                                            return;
                                        }
                                    }
                                }
                            }
                        }
                        
                        // 方法2: 通过类名 text-3xl font-medium 直接查找金额
                        const amountEls = iframeDoc.querySelectorAll('div.text-3xl.font-medium');
                        for (const el of amountEls) {
                            const match = (el.textContent || '').trim().match(/\$[\d,]+\.?\d*/);
                            if (match) {
                                const volume = parseFloat(match[0].replace(/[$,]/g, ''));
                                if (!isNaN(volume) && volume > 1000) {
                                    if (!resolved) {
                                        resolved = true;
                                        clearTimeout(timeout);
                                        currentVolume = volume;
                                        lastVolumeCheck = Date.now();
                                        log(`📊 当前交易额: $${volume.toLocaleString()}`, 'success');
                                        cleanup();
                                        resolve(volume);
                                        return;
                                    }
                                }
                            }
                        }
                        
                        // 方法3: 旧结构兼容 - 查找包含 "SPOT VOL" 或 "RETRO" 的容器
                        const allDivs = iframeDoc.querySelectorAll('div');
                        for (const div of allDivs) {
                            const text = div.textContent || '';
                            if ((text.includes('SPOT VOL') || text.includes('RETRO')) && text.includes('$')) {
                                const priceMatch = text.match(/\$[\d,]+\.?\d*/g);
                                if (priceMatch) {
                                    let maxVolume = 0;
                                    for (const p of priceMatch) {
                                        const v = parseFloat(p.replace(/[$,]/g, ''));
                                        if (v > maxVolume) maxVolume = v;
                                    }
                                    if (maxVolume > 1000) {
                                        if (!resolved) {
                                            resolved = true;
                                            clearTimeout(timeout);
                                            currentVolume = maxVolume;
                                            lastVolumeCheck = Date.now();
                                            log(`📊 当前交易额: $${maxVolume.toLocaleString()}`, 'success');
                                            cleanup();
                                            resolve(maxVolume);
                                            return;
                                        }
                                    }
                                }
                            }
                        }
                        
                        // 未找到，继续尝试
                        if (attempts < maxAttempts) {
                            setTimeout(tryRead, 500);
                        } else {
                            if (!resolved) {
                                resolved = true;
                                clearTimeout(timeout);
                                log('⚠️ 未能解析交易额（元素未找到）', 'warning');
                                cleanup();
                                resolve(null);
                            }
                        }
                    } catch (e) {
                        if (attempts < maxAttempts) {
                            setTimeout(tryRead, 500);
                        } else {
                            if (!resolved) {
                                resolved = true;
                                clearTimeout(timeout);
                                log(`⚠️ 获取交易额失败: ${e.message}`, 'warning');
                                cleanup();
                                resolve(null);
                            }
                        }
                    }
                };
                
                // 首次等待 1 秒让页面渲染
                setTimeout(tryRead, 1000);
            };
            
            iframe.onerror = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    log('⚠️ iframe 加载失败', 'warning');
                    cleanup();
                    resolve(null);
                }
            };
            
            document.body.appendChild(iframe);
        });
    };
    
    // 检查是否达到交易额限制
    const checkVolumeLimit = async () => {
        if (!enableVolumeLimit) return false;
        
        // 每 5 笔交易检查一次，或者首次检查
        const shouldCheck = (stats.successfulSwaps % 5 === 0) || lastVolumeCheck === 0;
        
        if (shouldCheck) {
            const volume = await fetchCurrentVolume();
            if (volume !== null && volume >= volumeLimitTarget) {
                log(`🎯 已达到交易额目标 ($${volume.toLocaleString()} >= $${volumeLimitTarget.toLocaleString()})，自动停止`, 'success');
                return true;
            }
        }
        
        return false;
    };
    
    // 检查是否在正确的交易页面
    const isOnTradePage = () => {
        const currentUrl = window.location.href;
        return currentUrl.startsWith(TRADE_PAGE_URL);
    };
    
    // 导航到交易页面
    const navigateToTradePage = () => {
        log('🔀 检测到页面不正确，正在导航到交易页面...', 'warning');
        try {
            localStorage.setItem('tradegenius_autostart', 'true');
            localStorage.setItem('tradegenius_speed', speedMultiplier.toString());
        } catch (e) {}
        window.location.href = TRADE_PAGE_URL;
    };

    // 刷新页面并自动重启（若用户已点击停止，则仅刷新不设自动重启）
    const refreshAndRestart = () => {
        const userStopped = localStorage.getItem('tradegenius_user_stopped') === 'true';
        if (userStopped) {
            try { localStorage.removeItem('tradegenius_user_stopped'); } catch (e) {}
            log('用户已停止，仅刷新页面，不自动重启', 'info');
        } else {
            log('🔄 连续失败过多，刷新页面并重启...', 'warning');
            try {
                localStorage.setItem('tradegenius_autostart', 'true');
                localStorage.setItem('tradegenius_speed', speedMultiplier.toString());
            } catch (e) {}
        }
        setTimeout(() => window.location.reload(), 1000);
    };

    // ==================== 新号一键部署（独立功能，与交易逻辑无关） ====================
    const checkDeployRunning = () => isDeployRunning;
    const deploySleep = (ms) => new Promise(resolve => {
        const t0 = Date.now();
        const tick = () => {
            if (!isDeployRunning || Date.now() - t0 >= ms) { resolve(); return; }
            setTimeout(tick, 100);
        };
        setTimeout(tick, Math.min(100, ms));
    });

    const DEPLOY_CHAINS = [
        { name: 'Solana', evm: false },
        { name: 'Optimism', evm: true },
        { name: 'BNB', evm: true },
        { name: 'Arbitrum', evm: true },
        { name: 'Base', evm: true }
    ];
    const AGGREGATORS_OFF = ['odos', 'kyberswap', 'openocean', 'lifi', 'uniswapv2', 'uniswapv3'];
    const AGGREGATORS_ON = ['okx', '0x', 'evmdirectpool', 'lfj', 'algebra', 've33'];

    // 部署完成后添加代币到 Saved（与 添加代币到Saved.js 流程一致）
    const DEPLOY_SAVED_STABLE = 'USDC';
    const DEPLOY_SAVED_SEARCH = 'KOGE';
    const DEPLOY_SAVED_CA = '0xb2d97c4ed2d0ef452654f5cab3da3735b5e6f3ab';
    const DEPLOY_SAVED_WAIT_CLICK = 800;
    const DEPLOY_SAVED_WAIT_INPUT = 1200;
    const DEPLOY_SAVED_STAR_TIMEOUT = 10000;
    const DEPLOY_SAVED_SEARCH_TIMEOUT = 14000;
    const DEPLOY_SAVED_RETRY_DELAY = 2000;
    const DEPLOY_SAVED_POLL = 400;
    const DEPLOY_SAVED_MAX_STAR_RETRIES = 2;

    const findDeployEl = (selectorOrFn, timeout = 3000) => {
        const deadline = Date.now() + timeout;
        const fn = typeof selectorOrFn === 'function' ? selectorOrFn : () => document.querySelector(selectorOrFn);
        return new Promise((resolve) => {
            const check = () => {
                if (!isDeployRunning) { resolve(null); return; }
                const el = fn();
                if (el) { resolve(el); return; }
                if (Date.now() > deadline) { resolve(null); return; }
                setTimeout(check, 150);
            };
            check();
        });
    };

    // 部署用：可靠点击。Radix switch 只点一次（点两次会来回切换导致状态错误）
    const deployClick = async (el) => {
        if (!el || !el.offsetParent) return false;
        const isSwitch = (el.getAttribute('role') === 'switch');
        if (isSwitch) {
            el.scrollIntoView({ block: 'center', behavior: 'auto' });
            await deploySleep(150);
            el.focus();
            el.click();
            await deploySleep(300);
            return true;
        }
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        try {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
        } catch (e) {
            el.click();
        }
        await deploySleep(350);
        return true;
    };

    // 部署用：React 兼容设置 input 值
    const deploySetInput = (input, value) => {
        if (!input) return false;
        input.focus();
        try {
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (desc && desc.set) {
                desc.set.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        } catch (e) {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
    };

    // 部署后添加代币到 Saved：依赖 getDialog/findChooseButtons/findStableTab/findSavedTab/findCloseButton（主脚本 DOM 区定义）
    const deploySavedGetDialog = () => document.querySelector('[role="dialog"]') || document.body;
    const deploySavedFindRowByTokenName = (tokenName) => {
        const dialog = deploySavedGetDialog();
        const rows = dialog.querySelectorAll('div[class*="cursor-pointer"][class*="hover:bg-genius-blue"], div[class*="py-2"][class*="px-4"]');
        for (const row of Array.from(rows)) {
            if (!row.offsetParent) continue;
            const text = (row.textContent || '').trim();
            if (text.includes(tokenName) && text.includes('$') && row.querySelector('svg[class*="lucide-star"]')) return row;
        }
        return null;
    };
    const deploySavedFindRowByLogo = (tokenSymbol) => {
        const dialog = deploySavedGetDialog();
        const sym = (tokenSymbol || '').trim().toLowerCase().replace(/\.png$/i, '');
        if (!sym) return null;
        const suffix = sym + '.png';
        for (const img of dialog.querySelectorAll('img')) {
            const raw = ((img.src || '') + (img.getAttribute('srcset') || '')).toLowerCase();
            if (!raw.includes('tokenlogos') || !raw.includes(suffix)) continue;
            const row = img.closest('div[class*="cursor-pointer"][class*="hover:bg-genius-blue"]') || img.closest('div[class*="py-2"][class*="px-4"]') || img.closest('div[class*="cursor-pointer"]');
            if (!row || !(row.textContent || '').includes('$') || row.offsetParent === null) continue;
            return row;
        }
        return null;
    };
    const deploySavedIsStarSaved = (row) => {
        if (!row || !row.isConnected) return false;
        const star = row.querySelector('svg[class*="lucide-star"]') || row.querySelector('[class*="lucide-star"]');
        if (!star) return false;
        const c = (typeof star.className === 'string' ? star.className : (star.getAttribute && star.getAttribute('class')) || '').toString();
        return c.includes('fill-genius-yellow') || c.includes('text-genius-yellow');
    };
    const deploySavedWaitForStarSaved = async (rowOrGetRow, timeout = DEPLOY_SAVED_STAR_TIMEOUT) => {
        await deploySleep(400);
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (!isDeployRunning) return false;
            const row = typeof rowOrGetRow === 'function' ? rowOrGetRow() : rowOrGetRow;
            if (row && deploySavedIsStarSaved(row)) return true;
            await deploySleep(DEPLOY_SAVED_POLL);
        }
        return false;
    };
    const deploySavedClickStarInRow = (row) => {
        const star = row && (row.querySelector('svg[class*="lucide-star"]') || row.querySelector('[class*="lucide-star"]'));
        if (!star) return false;
        try {
            if (typeof star.click === 'function') star.click();
            else star.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return true;
        } catch (e) {
            const parent = star.closest('div[class*="cursor-pointer"]') || star.parentElement;
            if (parent && typeof parent.click === 'function') parent.click();
            return !!parent;
        }
    };
    const deploySavedFindSearchInput = () => {
        const dialog = deploySavedGetDialog();
        return dialog.querySelector('input[placeholder="Search"]') || dialog.querySelector('input[type="text"][class*="rounded-sm"]') || dialog.querySelector('input[class*="bg-genius-indigo"]');
    };
    const deploySavedFindStableTab = () => {
        const dialog = deploySavedGetDialog();
        const tabRow = dialog.querySelector('div.flex.flex-row.w-full.gap-3') || dialog.querySelector('div[class*="gap-3"][class*="flex-row"]');
        if (tabRow) {
            for (const tab of tabRow.querySelectorAll('div')) {
                if ((tab.textContent || '').trim() === 'Stable' && tab.offsetParent !== null) return tab;
            }
        }
        for (const div of dialog.querySelectorAll('div')) {
            const t = (div.textContent || '').trim();
            const c = div.className || '';
            if (t === 'Stable' && (c.includes('cursor-pointer') || c.includes('flex-col')) && div.offsetParent !== null) return div;
        }
        return null;
    };
    const deploySavedFindSavedTab = () => {
        const dialog = deploySavedGetDialog();
        const tabRow = dialog.querySelector('div.flex.flex-row.w-full.gap-3') || dialog.querySelector('div[class*="gap-3"][class*="flex-row"]');
        if (tabRow) {
            for (const tab of tabRow.querySelectorAll('div')) {
                if ((tab.textContent || '').trim() === 'Saved' && tab.offsetParent !== null) return tab;
            }
        }
        for (const div of dialog.querySelectorAll('div')) {
            const t = (div.textContent || '').trim();
            const c = div.className || '';
            if (t === 'Saved' && (c.includes('cursor-pointer') || c.includes('flex-col')) && div.offsetParent !== null) return div;
        }
        return null;
    };
    const deploySavedFindCloseButton = () => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return null;
        return dialog.querySelector('button[aria-label="Close"]') || Array.from(document.querySelectorAll('button')).find(b => ((b.textContent || '').trim() === 'Close' || (b.textContent || '').trim() === '关闭') && (b.className || '').includes('bg-genius-pink'));
    };
    const deploySavedClickEl = (el) => {
        if (!el || !el.offsetParent) return false;
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
        el.click();
        return true;
    };

    async function runDeployAddToSaved(logDeploy) {
        if (!DEPLOY_SAVED_CA) return;
        const getDialog = deploySavedGetDialog;
        const findChooseButtons = () => Array.from(document.querySelectorAll('button')).filter(b => {
            const text = (b.innerText || b.textContent || '').trim();
            const spanText = b.querySelector('span')?.innerText?.trim() || '';
            return (text === 'Choose' || spanText === 'Choose') && b.offsetParent !== null;
        });
        const waitForDialogOpen = async (timeout) => {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                if (!isDeployRunning) return false;
                if (!!document.querySelector('[role="dialog"]')) return true;
                await deploySleep(DEPLOY_SAVED_POLL);
            }
            return false;
        };
        const waitForTokenRow = async (tokenName, timeout) => {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                if (!isDeployRunning) return null;
                const row = deploySavedFindRowByLogo(tokenName) || deploySavedFindRowByTokenName(tokenName);
                if (row) return row;
                await deploySleep(DEPLOY_SAVED_POLL);
            }
            return null;
        };
        logDeploy('添加代币到 Saved：点击第二个 Choose…', 'info');
        const chooseBtns = findChooseButtons();
        const secondChoose = chooseBtns[1];
        if (!secondChoose) { logDeploy('未找到第二个 Choose', 'error'); return; }
        deploySavedClickEl(secondChoose);
        await deploySleep(DEPLOY_SAVED_WAIT_CLICK);
        const opened = await waitForDialogOpen(10000);
        if (!opened) { logDeploy('代币弹窗未打开', 'error'); return; }
        logDeploy('代币弹窗已打开，点击 Stable', 'info');
        const stableTab = deploySavedFindStableTab();
        if (!stableTab) { logDeploy('未找到 Stable 标签', 'error'); return; }
        deploySavedClickEl(stableTab);
        await deploySleep(DEPLOY_SAVED_WAIT_CLICK);
        let row = deploySavedFindRowByLogo(DEPLOY_SAVED_STABLE) || deploySavedFindRowByTokenName(DEPLOY_SAVED_STABLE);
        if (!row) {
            await deploySleep(DEPLOY_SAVED_RETRY_DELAY);
            row = await waitForTokenRow(DEPLOY_SAVED_STABLE, 8000);
        }
        if (!row) { logDeploy('未找到 ' + DEPLOY_SAVED_STABLE + ' 行', 'error'); return; }
        logDeploy('收藏 ' + DEPLOY_SAVED_STABLE + '（点星星）', 'info');
        deploySavedClickStarInRow(row);
        let ok = await deploySavedWaitForStarSaved(() => deploySavedFindRowByLogo(DEPLOY_SAVED_STABLE) || deploySavedFindRowByTokenName(DEPLOY_SAVED_STABLE));
        if (!ok && DEPLOY_SAVED_MAX_STAR_RETRIES > 0) {
            for (let retry = 1; retry <= DEPLOY_SAVED_MAX_STAR_RETRIES; retry++) {
                logDeploy(DEPLOY_SAVED_STABLE + ' 星星未变黄，' + (DEPLOY_SAVED_RETRY_DELAY / 1000) + 's 后重试检测（' + retry + '/' + DEPLOY_SAVED_MAX_STAR_RETRIES + '）…', 'info');
                await deploySleep(DEPLOY_SAVED_RETRY_DELAY);
                ok = await deploySavedWaitForStarSaved(() => deploySavedFindRowByLogo(DEPLOY_SAVED_STABLE) || deploySavedFindRowByTokenName(DEPLOY_SAVED_STABLE), 8000);
                if (ok) break;
            }
        }
        if (!ok) logDeploy(DEPLOY_SAVED_STABLE + ' 星星未变黄', 'warning');
        const searchInput = deploySavedFindSearchInput();
        if (!searchInput || !searchInput.offsetParent) { logDeploy('未找到搜索框', 'error'); return; }
        logDeploy('搜索 ' + DEPLOY_SAVED_SEARCH + '…', 'info');
        deploySetInput(searchInput, DEPLOY_SAVED_SEARCH);
        await deploySleep(DEPLOY_SAVED_WAIT_INPUT);
        row = await waitForTokenRow(DEPLOY_SAVED_SEARCH, DEPLOY_SAVED_SEARCH_TIMEOUT);
        if (!row) {
            await deploySleep(DEPLOY_SAVED_RETRY_DELAY);
            deploySetInput(searchInput, DEPLOY_SAVED_SEARCH);
            await deploySleep(DEPLOY_SAVED_WAIT_INPUT);
            row = await waitForTokenRow(DEPLOY_SAVED_SEARCH, 8000);
        }
        if (row) {
            logDeploy('收藏 ' + DEPLOY_SAVED_SEARCH + '（点星星）', 'info');
            deploySavedClickStarInRow(row);
            ok = await deploySavedWaitForStarSaved(() => deploySavedFindRowByLogo(DEPLOY_SAVED_SEARCH) || deploySavedFindRowByTokenName(DEPLOY_SAVED_SEARCH));
            if (!ok && DEPLOY_SAVED_MAX_STAR_RETRIES > 0) {
                for (let retry = 1; retry <= DEPLOY_SAVED_MAX_STAR_RETRIES; retry++) {
                    logDeploy(DEPLOY_SAVED_SEARCH + ' 星星未变黄，' + (DEPLOY_SAVED_RETRY_DELAY / 1000) + 's 后重试检测（' + retry + '/' + DEPLOY_SAVED_MAX_STAR_RETRIES + '）…', 'info');
                    await deploySleep(DEPLOY_SAVED_RETRY_DELAY);
                    ok = await deploySavedWaitForStarSaved(() => deploySavedFindRowByLogo(DEPLOY_SAVED_SEARCH) || deploySavedFindRowByTokenName(DEPLOY_SAVED_SEARCH), 8000);
                    if (ok) break;
                }
            }
            if (!ok) logDeploy(DEPLOY_SAVED_SEARCH + ' 星星未变黄', 'warning');
        }
        logDeploy('搜索 CA…', 'info');
        deploySetInput(searchInput, DEPLOY_SAVED_CA);
        await deploySleep(DEPLOY_SAVED_WAIT_INPUT);
        const reStable = new RegExp('\\b' + (DEPLOY_SAVED_STABLE || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        const reSearch = new RegExp('\\b' + (DEPLOY_SAVED_SEARCH || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        const findCARow = () => {
            const rows = getDialog().querySelectorAll('div[class*="cursor-pointer"]');
            for (const r of Array.from(rows)) {
                if (!r.offsetParent || !r.querySelector('svg[class*="lucide-star"]')) continue;
                const text = (r.textContent || '').trim();
                if (reStable.test(text) || reSearch.test(text)) continue;
                if ((text || '').includes('$')) return r;
            }
            return null;
        };
        let deadline = Date.now() + DEPLOY_SAVED_SEARCH_TIMEOUT;
        let caRow = null;
        while (Date.now() < deadline) {
            if (!isDeployRunning) return;
            caRow = findCARow();
            if (caRow) break;
            await deploySleep(DEPLOY_SAVED_POLL);
        }
        if (!caRow) {
            await deploySleep(DEPLOY_SAVED_RETRY_DELAY);
            deploySetInput(searchInput, DEPLOY_SAVED_CA);
            await deploySleep(DEPLOY_SAVED_WAIT_INPUT);
            deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
                if (!isDeployRunning) return;
                caRow = findCARow();
                if (caRow) break;
                await deploySleep(DEPLOY_SAVED_POLL);
            }
        }
        if (caRow) {
            logDeploy('收藏 CA 代币（点星星）', 'info');
            deploySavedClickStarInRow(caRow);
            const getCARow = () => {
                const rows = getDialog().querySelectorAll('div[class*="cursor-pointer"]');
                for (const r of Array.from(rows)) {
                    if (!r.offsetParent || !r.querySelector('svg[class*="lucide-star"]')) continue;
                    const text = (r.textContent || '').trim();
                    if (reStable.test(text) || reSearch.test(text)) continue;
                    if ((text || '').includes('$')) return r;
                }
                return null;
            };
            let caOk = await deploySavedWaitForStarSaved(getCARow);
            if (!caOk && DEPLOY_SAVED_MAX_STAR_RETRIES > 0) {
                for (let retry = 1; retry <= DEPLOY_SAVED_MAX_STAR_RETRIES; retry++) {
                    logDeploy('CA 代币星星未变黄，' + (DEPLOY_SAVED_RETRY_DELAY / 1000) + 's 后重试检测（' + retry + '/' + DEPLOY_SAVED_MAX_STAR_RETRIES + '）…', 'info');
                    await deploySleep(DEPLOY_SAVED_RETRY_DELAY);
                    caOk = await deploySavedWaitForStarSaved(getCARow, 8000);
                    if (caOk) break;
                }
            }
            if (!caOk) logDeploy('CA 代币星星未变黄', 'warning');
        }
        const savedTab = deploySavedFindSavedTab();
        if (savedTab) {
            deploySavedClickEl(savedTab);
            await deploySleep(1500);
        }
        const closeBtn = deploySavedFindCloseButton();
        if (closeBtn && closeBtn.offsetParent) {
            deploySavedClickEl(closeBtn);
            logDeploy('已关闭代币弹窗', 'success');
        }
        logDeploy('添加代币到 Saved 完成', 'success');
    }

    async function runDeployLoop() {
        const logDeploy = (msg, type = 'info') => log(`[部署] ${msg}`, type);
        logDeploy('新号一键部署开始', 'info');
        try {
            const clickEl = async (el) => { if (el) { el.click(); await deploySleep(400); } return !!el; };

            // 1. 点击设置
            const settingsBtn = await findDeployEl(() =>
                Array.from(document.querySelectorAll('svg')).find(s => (s.getAttribute('class') || '').includes('lucide-settings2'))?.closest('div[class*="cursor-pointer"]')
            );
            if (!checkDeployRunning()) return;
            if (!settingsBtn) { logDeploy('未找到设置按钮', 'warning'); return; }
            logDeploy('点击设置', 'info');
            await clickEl(settingsBtn);
            await deploySleep(800);

            // 2. 多链滑点：固定找「当前页面」的 NetworkButton（同一颗），每次打开下拉再点菜单项
            for (const chain of DEPLOY_CHAINS) {
                if (!checkDeployRunning()) return;
                logDeploy(`处理链: ${chain.name}`, 'info');
                const networkBtn = await findDeployEl(() => {
                    const btn = document.querySelector('[data-sentry-component="NetworkButton"]');
                    if (btn && btn.offsetParent) return btn;
                    const all = document.querySelectorAll('div[class*="border-genius-blue"][class*="cursor-pointer"]');
                    return Array.from(all).find(d => d.querySelector('svg') && (d.textContent || '').trim().length > 0) || null;
                }, 2500);
                if (networkBtn) {
                    await deployClick(networkBtn);
                    await deploySleep(600);
                    const chainItem = await findDeployEl(() => {
                        const menu = document.querySelector('[role="menu"], [data-radix-menu-content]');
                        if (!menu) return null;
                        const spans = menu.querySelectorAll('span.text-genius-cream, span[class*="text-genius-cream"]');
                        for (const s of spans) {
                            if ((s.textContent || '').trim() === chain.name) {
                                const row = s.closest('div[class*="cursor-pointer"]') || s.closest('div[class*="flex"]');
                                return row || s;
                            }
                        }
                        return null;
                    }, 2000);
                    if (chainItem) await deployClick(chainItem);
                    else logDeploy(`未找到链菜单项: ${chain.name}`, 'warning');
                    await deploySleep(700);
                } else {
                    logDeploy('未找到多链选择框', 'warning');
                }
                const fillVisibleInputs = () => {
                    const inputs = document.querySelectorAll('input[class*="border-genius-blue"], input[class*="bg-genius-blue/40"]');
                    for (const inp of Array.from(inputs)) {
                        if (!inp.offsetParent) continue;
                        const isGwei = (inp.className || '').includes('text-center') && (inp.closest('div')?.textContent || '').toLowerCase().includes('priority');
                        if (chain.evm && isGwei) { deploySetInput(inp, '0.01'); continue; }
                        deploySetInput(inp, '0.01');
                    }
                };
                const buyBtn = await findDeployEl(() => Array.from(document.querySelectorAll('button')).find(b => /^Buy\s*$/i.test((b.textContent || '').trim()) && (b.className || '').includes('text-genius-green')));
                if (buyBtn) {
                    await deployClick(buyBtn);
                    await deploySleep(500);
                    fillVisibleInputs();
                    await deploySleep(200);
                }
                const sellBtn = await findDeployEl(() => Array.from(document.querySelectorAll('button')).find(b => /^Sell\s*$/i.test((b.textContent || '').trim()) && (b.className || '').includes('border-genius-blue')));
                if (sellBtn) {
                    await deployClick(sellBtn);
                    await deploySleep(500);
                    fillVisibleInputs();
                    await deploySleep(200);
                }
                await deploySleep(400);
            }

            // 2.5 Trading Pre-sets 滑点设置完成后，点击 Save 保存（Save 按钮在 Trading Pre-sets 界面）
            if (!checkDeployRunning()) return;
            const saveBtn = await findDeployEl(() => {
                const buttons = document.querySelectorAll('button');
                return Array.from(buttons).find(b => {
                    const t = (b.textContent || '').trim();
                    if (t !== 'Save') return false;
                    const c = b.className || '';
                    return c.includes('bg-genius-pink') && (c.includes('text-genius-blue') || c.includes('genius-pink-foreground'));
                }) || Array.from(buttons).find(b => (b.textContent || '').trim() === 'Save' && (b.className || '').includes('bg-genius-pink')) || null;
            }, 2000);
            if (saveBtn) {
                saveBtn.scrollIntoView({ block: 'center', behavior: 'auto' });
                await deploySleep(300);
                await deployClick(saveBtn);
                logDeploy('已点击 Save 保存 (Trading Pre-sets)', 'success');
                await deploySleep(500);
            } else {
                logDeploy('未找到 Save 按钮，请手动保存', 'warning');
            }

            // 3. Aggregator/Fast Swaps：点击入口，仅在本区域内按名称依次点击 Button(role=switch)（自动保存，无需 Save）
            if (!checkDeployRunning()) return;
            const aggEntry = await findDeployEl(() =>
                Array.from(document.querySelectorAll('div')).find(d => (d.textContent || '').trim() === 'Aggregator/Fast Swaps')
            );
            if (aggEntry) {
                await deployClick(aggEntry);
                await deploySleep(800);
                const aggContent = Array.from(document.querySelectorAll('div')).find(d => (d.textContent || '').includes('odos') && (d.className || '').includes('border-genius-blue'));
                const container = aggContent || aggEntry.closest('div[class*="flex"]') || document.body;
                const switches = container.querySelectorAll ? Array.from(container.querySelectorAll('button[role="switch"]')).filter(s => s.offsetParent) : Array.from(document.querySelectorAll('button[role="switch"]')).filter(s => s.offsetParent);
                for (const toggle of switches) {
                    if (!checkDeployRunning()) return;
                    const row = toggle.closest('div[class*="flex"]');
                    const labelEl = row && (row.querySelector('[class*="text-genius-cream"]') || row);
                    const label = (labelEl && labelEl.textContent) ? labelEl.textContent.trim() : '';
                    const name = label.toLowerCase().replace(/\s/g, '');
                    if (!name) continue;
                    const shouldOn = AGGREGATORS_ON.some(a => name.includes(a));
                    const shouldOff = AGGREGATORS_OFF.some(a => name.includes(a));
                    const checked = (toggle.getAttribute('aria-checked') || toggle.getAttribute('data-state')) === 'true' || (toggle.getAttribute('data-state') === 'checked');
                    if (shouldOn && !checked) { await deployClick(toggle); await deploySleep(200); }
                    if (shouldOff && checked) { await deployClick(toggle); await deploySleep(200); }
                }
                await deploySleep(400);
            }

            // 4. Fees：与 Aggregator 不同，此处只有一个 switch（Show Fees）。按父级结构定位：Fees → Show Fees → border 容器 → button[role=switch]
            if (!checkDeployRunning()) return;
            const feesEntry = await findDeployEl(() =>
                Array.from(document.querySelectorAll('div')).find(d => (d.textContent || '').trim() === 'Fees')
            );
            if (feesEntry) {
                await deployClick(feesEntry);
                await deploySleep(700);
                const feesSwitch = await findDeployEl(() => {
                    const showFeesLabel = Array.from(document.querySelectorAll('div')).find(d => (d.textContent || '').trim() === 'Show Fees');
                    if (showFeesLabel) {
                        const borderBox = showFeesLabel.parentElement?.querySelector('div[class*="border-genius-blue"][class*="rounded-sm"]') || showFeesLabel.nextElementSibling;
                        if (borderBox) {
                            const btn = borderBox.querySelector('button[role="switch"]');
                            if (btn) return btn;
                        }
                    }
                    const hint = Array.from(document.querySelectorAll('div')).find(d =>
                        (d.textContent || '').includes('Displays the Genius') || (d.textContent || '').includes('Sponsor, Gas and LND fees')
                    );
                    if (hint) {
                        const container = hint.closest('div[class*="border-genius-blue"][class*="rounded-sm"]') || hint.parentElement;
                        if (container) return container.querySelector('button[role="switch"]');
                    }
                    return null;
                }, 1500);
                if (feesSwitch) {
                    const checked = (feesSwitch.getAttribute('aria-checked') || feesSwitch.getAttribute('data-state')) === 'true' || feesSwitch.getAttribute('data-state') === 'checked';
                    if (!checked) {
                        await deployClick(feesSwitch);
                        logDeploy('已点击 Show Fees 开关（保持开启）', 'info');
                    }
                } else {
                    logDeploy('未找到 Fees 区域内 Show Fees 开关', 'warning');
                }
            }

            // Fees 结束后先关闭设置弹窗（lucide-x 图标按钮），等待 1–2 秒后再执行添加代币到 Saved
            if (!checkDeployRunning()) return;
            const settingsDialog = document.querySelector('[role="dialog"]');
            if (settingsDialog) {
                const xSvg = settingsDialog.querySelector('svg[class*="lucide-x"]');
                const closeBtn = xSvg ? (xSvg.closest('button') || xSvg.parentElement) : (settingsDialog.querySelector('button[aria-label="Close"]') || Array.from(settingsDialog.querySelectorAll('button')).find(b => ((b.textContent || '').trim() === 'Close' || (b.textContent || '').trim() === '关闭') && (b.className || '').includes('bg-genius-pink')));
                if (closeBtn && closeBtn.offsetParent) {
                    logDeploy('关闭设置弹窗…', 'info');
                    closeBtn.click();
                }
            }
            await deploySleep(1500);
            const dialogStillOpen = !!document.querySelector('[role="dialog"]');
            if (dialogStillOpen) logDeploy('设置弹窗未关闭，继续执行添加代币', 'warning');

            if (checkDeployRunning() && DEPLOY_SAVED_CA) {
                await runDeployAddToSaved(logDeploy);
            }

            logDeploy('新号一键部署流程执行完毕', 'success');
        } catch (e) {
            log(`[部署] 错误: ${e.message}`, 'error');
        } finally {
            isDeployRunning = false;
            if (UI.setDeployRunning) UI.setDeployRunning(false);
        }
    }

    function stopDeployLoop() {
        isDeployRunning = false;
        log('[部署] 已停止', 'warning');
        if (UI.setDeployRunning) UI.setDeployRunning(false);
    }

    // ==================== DOM 查找函数 ====================
    
    // 查找 Choose 按钮（参考GitHub脚本）
    const findChooseButtons = () => {
        return Array.from(document.querySelectorAll('button'))
            .filter(b => {
                const text = (b.innerText || b.textContent || '').trim();
                const spanText = b.querySelector('span')?.innerText?.trim() || '';
                return text === 'Choose' || spanText === 'Choose' ||
                       text === '选择' || spanText === '选择';
            })
            .filter(b => b.offsetParent !== null); // 只保留可见的
    };

    // 查找 Confirm 按钮
    const findConfirmButton = () => {
        return Array.from(document.querySelectorAll('button'))
            .find(b => {
                const text = (b.innerText || '').trim().toUpperCase();
                return (text.includes('CONFIRM') || text.includes('确认') || text.includes('PLACE')) &&
                       b.offsetParent !== null;
            });
    };

    // 查找 Close 按钮
    const findCloseButton = () => {
        return Array.from(document.querySelectorAll('button'))
            .find(b => {
                const text = (b.innerText || '').trim().toUpperCase();
                const hasClass = (b.className || '').includes('bg-genius-pink');
                return (text === 'CLOSE' || text === '关闭') && hasClass && b.offsetParent !== null;
            });
    };

    // 检查弹窗是否打开
    const isDialogOpen = () => {
        return !!document.querySelector('[role="dialog"]');
    };

    // 当前弹窗根节点（仅限弹窗内查找时复用，避免重复写 querySelector）
    const getDialog = () => document.querySelector('[role="dialog"]') || document.body;

    // 在弹窗内查找代币行（根据实际 HTML 结构优化）
    const findTokenRows = () => {
        const dialog = getDialog();
        
        // 根据实际 HTML 结构：代币行特征是 flex items-center justify-between ... cursor-pointer
        // 包含 md:hover:bg-genius-blue 类
        const rows = [];
        
        // 方法1: 精确匹配代币行（包含 hover:bg-genius-blue 或 md:hover:bg-genius-blue）
        const method1 = dialog.querySelectorAll('div[class*="hover:bg-genius-blue"]');
        method1.forEach(row => {
            if (row.offsetParent !== null) {
                const text = row.textContent || '';
                // 代币行应该包含价格符号 $
                if (text.includes('$')) {
                    rows.push(row);
                }
            }
        });
        
        // 方法2: 如果方法1找不到，用更宽泛的选择器
        if (rows.length === 0) {
            const method2 = dialog.querySelectorAll('div[class*="cursor-pointer"]');
            method2.forEach(row => {
                if (row.offsetParent !== null) {
                    const text = row.textContent || '';
                    const classes = row.className || '';
                    if (text.includes('$') && classes.includes('flex') && classes.includes('items-center')) {
                        if (classes.includes('flex-col') && classes.includes('text-sm')) return;
                        rows.push(row);
                    }
                }
            });
        }
        
        return rows;
    };

    // 查找标签（通用函数）
    const findTab = (tabName) => {
        const dialog = getDialog();
        
        // 方法1: 在 tab 行中查找
        const tabRow = dialog.querySelector('div.flex.flex-row.w-full.gap-3') || 
                      dialog.querySelector('div[class*="gap-3"][class*="flex-row"]');
        if (tabRow) {
            for (const tab of tabRow.querySelectorAll('div')) {
                if ((tab.textContent || '').trim() === tabName && tab.offsetParent !== null) {
                    return tab;
                }
            }
        }
        
        // 方法2: 遍历弹窗内所有 div
        for (const div of dialog.querySelectorAll('div')) {
            const text = (div.textContent || '').trim();
            if (text === tabName && div.offsetParent !== null) {
                const classes = div.className || '';
                if (classes.includes('cursor-pointer') || classes.includes('flex-col')) {
                    return div;
                }
            }
        }
        
        return null;
    };
    
    // 查找 Saved 标签
    const findSavedTab = () => findTab('Saved');
    
    // 查找 Stable 标签
    const findStableTab = () => findTab('Stable');
    
    // 查找 Gas 标签
    const findGasTab = () => findTab('Gas');

    // ==================== 核心操作函数 ====================

    // 等待弹窗打开
    const waitForDialogOpen = async (timeout = CONFIG.DIALOG_OPEN_TIMEOUT) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (isDialogOpen()) return true;
            await sleep(CONFIG.POLL_INTERVAL);
        }
        return false;
    };
    
    // 等待弹窗关闭
    const waitForDialogClose = async (timeout = CONFIG.DIALOG_CLOSE_TIMEOUT) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (!isDialogOpen()) return true;
            await sleep(CONFIG.POLL_INTERVAL);
        }
        return false;
    };
    
    // 等待元素出现
    const waitForElement = async (selectorOrFn, timeout = CONFIG.DIALOG_OPEN_TIMEOUT) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = typeof selectorOrFn === 'function' 
                ? selectorOrFn() 
                : document.querySelector(selectorOrFn);
            if (el) return el;
            await sleep(CONFIG.POLL_INTERVAL);
        }
        return null;
    };

    // 点击元素
    const clickElement = async (element) => {
        if (!element) throw new Error('元素不存在');
        
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(CONFIG.POLL_INTERVAL);
        
        // 按钮元素直接使用原生 click
        if (element.tagName === 'BUTTON' || element.tagName === 'A') {
            element.click();
            return;
        }
        
        // 其他元素使用事件模拟
        ['mousedown', 'mouseup', 'click'].forEach(type => {
            element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        });
        element.click?.();
    };

    // 按「视觉中心坐标」点击，避免 smooth 滚动未结束或叠加层导致点到别的行。用于代币行等易错目标。
    const clickElementAtCenter = async (element) => {
        if (!element) throw new Error('元素不存在');
        element.scrollIntoView({ behavior: 'auto', block: 'center' });
        await sleep(150);
        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const atPoint = document.elementFromPoint(centerX, centerY);
        const target = (atPoint && element.contains(atPoint)) ? atPoint : element;
        const opts = { bubbles: true, cancelable: true, clientX: centerX, clientY: centerY };
        ['mousedown', 'mouseup', 'click'].forEach(type => {
            target.dispatchEvent(new MouseEvent(type, opts));
        });
        if (typeof target.click === 'function') target.click();
    };

    // 仅用原生 element.click()，不派发 MouseEvent。部分 React 页面只认原生点击。
    const nativeClick = async (element) => {
        if (!element) throw new Error('元素不存在');
        element.scrollIntoView({ behavior: 'auto', block: 'center' });
        await sleep(220);
        element.click();
    };

    // 检查文本是否匹配目标代币
    const matchesTargetToken = (text) => {
        const upperText = text.toUpperCase();
        const token = targetToken.toUpperCase();
        return upperText.includes(token);
    };

    // 链名称到图片关键字的映射
    const CHAIN_IMAGE_MAP = {
        'BNB': 'binance',
        'Optimism': 'optimism',
        'Base': 'base',
        'Arbitrum': 'arbitrum',
        'Polygon': 'polygon',
        'Solana': 'solana',
        'OP': 'optimism',
        'BASE': 'base',
        'ARB': 'arbitrum',
        'POL': 'polygon',
        'SOL': 'solana'
    };
    
    // 检测代币行中是否包含指定的链
    const hasChainInRow = (row, chainName) => {
        const imageKeyword = CHAIN_IMAGE_MAP[chainName];
        if (!imageKeyword) return false;
        const imgs = row.querySelectorAll('img');
        for (const img of imgs) {
            const src = (img.src || '') + (img.getAttribute('srcset') || '');
            if (src.toLowerCase().includes(imageKeyword)) return true;
        }
        return false;
    };

    // 链按钮文案是否匹配指定链（多链浮层与全页找链共用）
    const matchesChainName = (btn, chainSymbol) => {
        const text = (btn.textContent || '').trim();
        const spanText = (btn.querySelector('span[class*="text-genius-cream"]')?.textContent || '').trim();
        return spanText === chainSymbol || text === chainSymbol ||
            (chainSymbol === 'BNB' && text.includes('BNB') && !text.includes('BNB48'));
    };

    /**
     * 诊断「USDT 行多链浮层未就绪」时的 DOM 与页面状态，便于判断是网页前端异常还是结构变化。
     * 仅在抛出前调用，结果输出到控制台，前缀 [Genius 诊断]。
     */
    function diagnoseUSDTFloatFail(rowUsed, chainSymbol, tokenSymbol) {
        const pref = '[Genius 诊断]';
        const out = (label, val) => console.warn(pref, label, val);
        try {
            const dialog = getDialog();
            out('1. 弹窗', dialog ? { tag: dialog.tagName, role: dialog.getAttribute?.('role'), isBody: dialog === document.body } : null);
            out('2. 当前行 rowUsed', rowUsed ? { tag: rowUsed.tagName, rect: rowUsed.getBoundingClientRect(), textSnippet: (rowUsed.textContent || '').slice(0, 80) } : null);
            const group = rowUsed?.closest?.('[class*="group"]');
            out('3. 行所在 group', group ? true : false);
            if (group) {
                const shadows = group.querySelectorAll?.('[class*="genius-shadow"]') || [];
                const grids = group.querySelectorAll?.('[class*="grid-cols-3"]') || [];
                out('4. group 内 genius-shadow 数量', shadows.length);
                out('5. group 内 grid-cols-3 数量', grids.length);
                if (shadows.length) Array.from(shadows).forEach((s, i) => out(`   shadow[${i}] rect`, s.getBoundingClientRect()));
            } else {
                out('4–5. 无 group，跳过', '-');
            }
            const allShadows = dialog?.querySelectorAll?.('[class*="genius-shadow"]') || [];
            out('6. 整个弹窗内 genius-shadow 总数', allShadows.length);
            const rowRect = rowUsed?.getBoundingClientRect?.();
            allShadows.forEach((s, i) => {
                const r = s.getBoundingClientRect();
                const hasChain = !!Array.from(s.querySelectorAll?.('div[class*="cursor-pointer"]') || []).find(b => matchesChainName(b, chainSymbol));
                out(`   弹窗内 shadow[${i}]`, { rect: r, 含目标链: hasChain, 在行下: rowRect ? r.top >= rowRect.bottom - 30 : 'N/A' });
            });
            const geoBtn = findChainButtonInPopupBelowRow(rowUsed, chainSymbol);
            out('7. 几何 fallback 是否找到链按钮', !!geoBtn);
            out('8. 建议', '若 4/5 为 0 且 6 也为 0，多为浮层未渲染或为前端异常；若 6>0 但 7 为 false，多为选择器/几何与当前页面不一致');
        } catch (e) {
            console.warn(pref, '诊断过程抛错（可能是页面异常）', e);
        }
    }

    /**
     * 在弹窗内按「几何位置」找位于 row 正下方、且包含指定链的浮层，返回该浮层内的链按钮（用于 group 内无 popup 时的 fallback）
     * 只选 top >= row.bottom - 20 的浮层，并取距离 row 底部最近的一个，避免点到 USDC 的浮层。
     */
    function findChainButtonInPopupBelowRow(rowUsed, chainSymbol) {
        const root = getDialog();
        const rowRect = rowUsed.getBoundingClientRect();
        const popups = root.querySelectorAll('[class*="genius-shadow"]');
        let best = { btn: null, dist: Infinity };
        for (const pop of popups) {
            const chainBtn = Array.from(pop.querySelectorAll('div[class*="cursor-pointer"]')).find(b => {
                if (!matchesChainName(b, chainSymbol)) return false;
                const c = (b.className || '');
                return (c.includes('p-1') || c.includes('hover:bg-genius-blue')) && b.offsetParent !== null;
            });
            if (!chainBtn) continue;
            const pr = pop.getBoundingClientRect();
            if (pr.width < 50 || pr.height < 50) continue;
            const dist = pr.top - rowRect.bottom;
            if (dist >= -30 && dist < best.dist) best = { btn: chainBtn, dist };
        }
        return best.btn;
    }

    /**
     * 在代币行对应的多链浮层内查找并点击指定链（仅当 group 内确有 tokenSymbol 时才用此浮层）
     * @param {HTMLElement} rowUsed - 代币行
     * @param {string} chainSymbol - 链名
     * @param {string} tokenSymbol - 代币名（用于校验 group 归属，避免误用 USDC 的浮层）
     * @returns {Promise<boolean>} 是否已在浮层内点击链并完成关闭等待
     */
    async function selectChainInMultiChainPopup(rowUsed, chainSymbol, tokenSymbol) {
        const group = rowUsed.closest('[class*="group"]');
        if (!group) {
            log('多链浮层未找到 group，fallback: 点行并全页找链', 'info');
            return false;
        }
        const hasTokenInGroup = Array.from(group.querySelectorAll('div[class*="text-sm"][class*="text-genius-cream"]')).some(el =>
            !(el.className || '').includes('text-genius-cream/60') &&
            (el.textContent || '').trim().toUpperCase() === (tokenSymbol || '').toUpperCase()
        );
        if (!hasTokenInGroup) {
            log(`多链浮层跳过：当前 group 内无 ${tokenSymbol}，fallback: 点行并全页找链`, 'info');
            return false;
        }
        const rect = rowUsed.getBoundingClientRect();
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        group.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        rowUsed.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
        await sleep(450);
        let popup = group.querySelector('[class*="genius-shadow"]');
        if (!popup) {
            const grid = group.querySelector('[class*="grid-cols-3"]');
            popup = grid && grid.parentElement ? grid.parentElement : null;
        }
        if (!popup) {
            await sleep(250);
            popup = group.querySelector('[class*="genius-shadow"]') || (group.querySelector('[class*="grid-cols-3"]')?.parentElement || null);
        }
        if (!popup) {
            log('多链浮层未找到 popup，fallback', 'info');
            return false;
        }
        const wasOpacity = popup.style.opacity;
        const wasPointer = popup.style.pointerEvents;
        popup.style.opacity = '1';
        popup.style.pointerEvents = 'auto';
        await sleep(100);
        const chainBtns = popup.querySelectorAll('div[class*="cursor-pointer"][class*="hover:bg-genius-blue"]');
        let chainButton = null;
        for (const btn of chainBtns) {
            if (matchesChainName(btn, chainSymbol)) {
                chainButton = btn;
                break;
            }
        }
        popup.style.opacity = wasOpacity;
        popup.style.pointerEvents = wasPointer;
        if (!chainButton) {
            log('多链浮层未找到链按钮，fallback: 点行并全页找链', 'info');
            return false;
        }
        await nativeClick(chainButton);
        log(`多链浮层已点击链 ${chainSymbol}`, 'success');
        await waitForDialogClose(CONFIG.DIALOG_CLOSE_TIMEOUT);
        return true;
    }

    // 选择代币（通过文本匹配）
    /**
     * 选择代币（第一个 Choose 用）：直接点击代币行，不需要链选择
     * @param {string} tokenSymbol - 代币符号
     * @returns {Promise<boolean>}
     */
    async function selectToken(tokenSymbol) {
        log(`查找代币: ${tokenSymbol}...`, 'info');
        
        // 先等待代币行元素出现，而不是固定延迟
        const rowsAppeared = await waitForElement(() => {
            const rows = findTokenRows();
            return rows.length > 0 ? rows : null;
        }, CONFIG.TOKEN_LIST_APPEAR_TIMEOUT);
        
        if (!rowsAppeared) {
            throw new Error(`代币列表未加载: ${tokenSymbol}`);
        }
        
        let targetRow = null;
        const isTargetToken = (tokenSymbol === targetToken || tokenSymbol === 'TARGET');
        
        for (let attempt = 0; attempt < CONFIG.maxRetryToken; attempt++) {
            const rows = findTokenRows();
            
            for (const row of rows) {
                const text = row.textContent || '';
                const hasPrice = text.includes('$');
                
                const baseTokenUpper = baseToken.toUpperCase();
                if (tokenSymbol.toUpperCase() === baseTokenUpper && 
                    text.toUpperCase().includes(baseTokenUpper) && 
                    !matchesTargetToken(text) && hasPrice) {
                    targetRow = row;
                    log(`✓ 找到 ${baseToken}`, 'success');
                    break;
                }
                
                if (isTargetToken && matchesTargetToken(text) && 
                    !text.toUpperCase().includes(baseTokenUpper) && hasPrice) {
                    targetRow = row;
                    log(`✓ 找到 ${targetToken}`, 'success');
                    break;
                }
            }
            
            if (targetRow) break;
            await randomSleep([600, 1000]);
        }
        
        if (!targetRow) {
            throw new Error(`未找到代币: ${tokenSymbol}`);
        }
        
        // 点击代币行
        await clickElement(targetRow);
        
        const closed = await waitForDialogClose(CONFIG.DIALOG_CLOSE_TIMEOUT);
        if (!closed) {
            log('⚠️ 弹窗未关闭，重试点击...', 'warning');
            const rows = findTokenRows();
            const baseTokenUpper = baseToken.toUpperCase();
            for (const row of rows) {
                const text = row.textContent || '';
                if ((tokenSymbol.toUpperCase() === baseTokenUpper && text.toUpperCase().includes(baseTokenUpper)) ||
                    (isTargetToken && matchesTargetToken(text))) {
                    await clickElement(row);
                    await waitForDialogClose(CONFIG.DIALOG_CLOSE_RETRY_WAIT);
                    break;
                }
            }
        }
        
        log(`✓ ${tokenSymbol} 已选择`, 'success');
        return true;
    }

    /**
     * 选择代币（第一个 Choose 用）：根据链标识选择代币行，不需要再点击链按钮
     * 代币行本身就带有链标识图片，直接点击即可选中
     * @param {string} tokenSymbol - 代币符号
     * @param {string} chainSymbol - 链符号
     * @returns {Promise<boolean>}
     */
    async function selectTokenByChain(tokenSymbol, chainSymbol) {
        log(`查找代币: ${tokenSymbol} (${chainSymbol} 链)...`, 'info');
        
        // 先等待代币行元素出现，而不是固定延迟
        const rowsAppeared = await waitForElement(() => {
            const rows = findTokenRows();
            return rows.length > 0 ? rows : null;
        }, CONFIG.TOKEN_LIST_APPEAR_TIMEOUT);
        
        if (!rowsAppeared) {
            throw new Error(`代币列表未加载: ${tokenSymbol}`);
        }
        
        const isBaseToken = tokenSymbol.toUpperCase() === baseToken.toUpperCase();
        const isTargetToken = tokenSymbol.toUpperCase() === targetToken.toUpperCase();
        
        // 查找带有指定链标识的代币行
        let targetRow = null;
        for (let attempt = 0; attempt < CONFIG.maxRetryToken; attempt++) {
            const rows = findTokenRows();
            for (const row of rows) {
                const text = row.textContent || '';
                const upperText = text.toUpperCase();
                
                // 先匹配代币
                let tokenMatched = false;
                const baseTokenUpper = baseToken.toUpperCase();
                if (isBaseToken) {
                    tokenMatched = upperText.includes(baseTokenUpper) && !matchesTargetToken(text) && text.includes('$');
                } else if (isTargetToken) {
                    tokenMatched = matchesTargetToken(text) && !upperText.includes(baseTokenUpper) && text.includes('$');
                } else {
                    tokenMatched = upperText.includes(tokenSymbol.toUpperCase()) && text.includes('$');
                }
                
                // 再匹配链标识
                if (tokenMatched && hasChainInRow(row, chainSymbol)) {
                    targetRow = row;
                    log(`✓ 找到 ${tokenSymbol} (${chainSymbol} 链)`, 'success');
                    break;
                }
            }
            if (targetRow) break;
            await fixedRandomSleep([600, 1000]);
        }
        
        if (!targetRow) {
            throw new Error(`未找到 ${tokenSymbol} (${chainSymbol} 链)`);
        }
        
        // 点击代币行即可选中
        await clickElement(targetRow);
        
        // 等待弹窗关闭（最多 5 秒）
        await waitForDialogClose(CONFIG.DIALOG_CLOSE_TIMEOUT);
        
        log(`✓ ${tokenSymbol} (${chainSymbol} 链) 已选择`, 'success');
        return true;
    }
    
    // 用 token logo URL 定位代币行（数据驱动，参考设置滑点.md：不依赖 DOM 文案/class，减少点错 USDC/USDT）
    // 页面用 /static/tokenlogos/usdt.png、usdc.png 等渲染，以此为唯一标识定位一行。
    function findTokenRowByLogo(tokenSymbol) {
        const dialog = getDialog();
        const sym = (tokenSymbol || '').trim().toLowerCase().replace(/\.png$/i, '');
        if (!sym) return null;
        const suffix = sym + '.png';
        for (const img of dialog.querySelectorAll('img')) {
            const raw = ((img.src || '') + (img.getAttribute('srcset') || '')).toLowerCase();
            if (!raw.includes('tokenlogos') || !raw.includes(suffix)) continue;
            const row = img.closest('div[class*="cursor-pointer"][class*="hover:bg-genius-blue"]')
                || img.closest('div[class*="py-2"][class*="px-4"]')
                || img.closest('div[class*="cursor-pointer"]');
            if (!row || !(row.textContent || '').includes('$') || row.offsetParent === null) continue;
            return row;
        }
        return null;
    }

    // 按文案匹配名字格（fallback，当 logo 定位失败时再用）
    function findTokenNameEl(tokenSymbol) {
        const dialog = getDialog();
        const keyword = (tokenSymbol || '').trim().toUpperCase();
        if (!keyword) return null;
        const all = dialog.querySelectorAll('div[class*="text-sm"][class*="text-genius-cream"]');
        for (const el of all) {
            const c = (el.className || '');
            if (c.includes('text-genius-cream/60')) continue;
            const t = (el.textContent || '').trim();
            if (t.toUpperCase() !== keyword) continue;
            if (t.length < 2 || t.length > 12) continue;
            const row = el.closest('div[class*="cursor-pointer"][class*="hover:bg-genius-blue"]')
                || el.closest('div[class*="py-2"][class*="px-4"]')
                || el.closest('div[class*="cursor-pointer"]');
            if (!row || !(row.textContent || '').includes('$')) continue;
            if (row.offsetParent === null) continue;
            return el;
        }
        return null;
    }

    // 选择代币并选择链（第二个 Choose 用）：点击代币行后会弹出链选择菜单，需要再点击链按钮
    async function selectTokenWithChain(tokenSymbol, chainSymbol) {
        log(`查找代币: ${tokenSymbol} (链: ${chainSymbol})...`, 'info');
        
        const isBaseToken = tokenSymbol.toUpperCase() === baseToken.toUpperCase();
        const isTargetToken = tokenSymbol.toUpperCase() === targetToken.toUpperCase();
        const baseTokenUpper = baseToken.toUpperCase();
        const tokenUpper = tokenSymbol.toUpperCase();
        const needExactSymbol = (isBaseToken || isTargetToken) && (baseTokenUpper !== targetToken.toUpperCase());
        
        let targetRow = null;
        let useNativeClick = false;
        let foundByLogo = false;
        if (needExactSymbol) {
            const rowByLogo = await waitForElement(() => findTokenRowByLogo(tokenSymbol), CONFIG.TOKEN_LIST_APPEAR_TIMEOUT);
            if (rowByLogo) {
                targetRow = rowByLogo;
                useNativeClick = true;
                foundByLogo = true;
                log(`✓ 找到 ${tokenSymbol}（按 token logo URL 匹配，避免误点 USDC/USDT）`, 'success');
            }
            if (!targetRow) {
                const nameEl = await waitForElement(() => findTokenNameEl(tokenSymbol), CONFIG.TOKEN_LIST_APPEAR_TIMEOUT);
                if (nameEl) {
                    targetRow = nameEl.closest('div[class*="cursor-pointer"][class*="hover:bg-genius-blue"]')
                        || nameEl.closest('div[class*="py-2"][class*="px-4"]')
                        || nameEl.closest('div[class*="cursor-pointer"]');
                    if (targetRow && (targetRow.textContent || '').includes('$')) {
                        log(`✓ 找到 ${tokenSymbol}（按文案匹配）`, 'success');
                        useNativeClick = true;
                    }
                }
            }
        }
        
        if (!targetRow) {
            const rowsAppeared = await waitForElement(() => {
                const rows = findTokenRows();
                return rows.length > 0 ? rows : null;
            }, CONFIG.TOKEN_LIST_APPEAR_TIMEOUT);
            if (!rowsAppeared) throw new Error(`代币列表未加载: ${tokenSymbol}`);
            
            for (let attempt = 0; attempt < CONFIG.maxRetryToken; attempt++) {
                const rows = findTokenRows();
                for (const row of rows) {
                    const text = row.textContent || '';
                    const upperText = text.toUpperCase();
                    let matched = false;
                    if (isBaseToken) {
                        matched = upperText.includes(baseTokenUpper) && !matchesTargetToken(text) && text.includes('$');
                    } else if (isTargetToken) {
                        matched = matchesTargetToken(text) && !upperText.includes(baseTokenUpper) && text.includes('$');
                    } else {
                        matched = upperText.includes(tokenUpper) && text.includes('$');
                    }
                    if (matched) {
                        targetRow = row;
                        log(`✓ 找到 ${tokenSymbol}`, 'success');
                        break;
                    }
                }
                if (targetRow) break;
                await fixedRandomSleep([800, 1200]);
            }
        }
        
        if (!targetRow) throw new Error(`未找到代币: ${tokenSymbol}`);
        
        let rowUsed = targetRow;
        if (useNativeClick) {
            const rowToClick = foundByLogo
                ? findTokenRowByLogo(tokenSymbol)
                : (() => { const el = findTokenNameEl(tokenSymbol); return el ? (el.closest('div[class*="cursor-pointer"][class*="hover:bg-genius-blue"]') || el.closest('div[class*="py-2"][class*="px-4"]') || el.closest('div[class*="cursor-pointer"]')) : null; })();
            if (rowToClick && (rowToClick.textContent || '').includes('$')) {
                rowUsed = rowToClick;
            }
            if (await selectChainInMultiChainPopup(rowUsed, chainSymbol, tokenSymbol)) {
                log(`✓ ${tokenSymbol} (${chainSymbol} 链) 已选择`, 'success');
                return true;
            }
            if (foundByLogo) {
                // 由 logo 找到的 USDT 行：禁止全页找链，否则会点到 USDC 的链。只在当前行 group 内找链。
                log('fallback: 仅在当前行 group 内找链（禁止全页，避免误点 USDC）', 'info');
                const group = rowUsed.closest('[class*="group"]');
                const findChainInGroup = () => {
                    if (!group) return null;
                    let popup = group.querySelector('[class*="genius-shadow"]');
                    if (!popup) popup = group.querySelector('[class*="grid-cols-3"]')?.parentElement || null;
                    const scope = popup || group;
                    for (const btn of scope.querySelectorAll('div[class*="cursor-pointer"]')) {
                        if (!matchesChainName(btn, chainSymbol)) continue;
                        const c = (btn.className || '');
                        if ((c.includes('p-1') || c.includes('hover:bg-genius-blue')) && btn.offsetParent !== null) return btn;
                    }
                    return null;
                };
                if (group) {
                    const r = rowUsed.getBoundingClientRect();
                    group.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                    rowUsed.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
                }
                await sleep(500);
                let chainInGroup = findChainInGroup();
                if (!chainInGroup) {
                    await nativeClick(rowUsed);
                    await sleep(600);
                    chainInGroup = findChainInGroup();
                }
                if (!chainInGroup) {
                    group && rowUsed && (group.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })), rowUsed.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: rowUsed.getBoundingClientRect().left + rowUsed.getBoundingClientRect().width / 2, clientY: rowUsed.getBoundingClientRect().top + rowUsed.getBoundingClientRect().height / 2 })));
                    await sleep(700);
                    chainInGroup = findChainInGroup();
                }
                if (chainInGroup) {
                    await nativeClick(chainInGroup);
                    log(`✓ 已在 ${tokenSymbol} 行浮层内点击 ${chainSymbol} 链`, 'success');
                    await waitForDialogClose(CONFIG.DIALOG_CLOSE_TIMEOUT);
                    log(`✓ ${tokenSymbol} (${chainSymbol} 链) 已选择`, 'success');
                    return true;
                }
                const geoBtn = findChainButtonInPopupBelowRow(rowUsed, chainSymbol);
                if (geoBtn) {
                    log('按几何位置找到该行下方的链浮层，点击链', 'info');
                    const pop = geoBtn.closest('[class*="genius-shadow"]');
                    if (pop) { pop.style.opacity = '1'; pop.style.pointerEvents = 'auto'; }
                    await sleep(80);
                    await nativeClick(geoBtn);
                    await waitForDialogClose(CONFIG.DIALOG_CLOSE_TIMEOUT);
                    log(`✓ ${tokenSymbol} (${chainSymbol} 链) 已选择（几何 fallback）`, 'success');
                    return true;
                }
                log(`⚠️ 未在 ${tokenSymbol} 行浮层内找到 ${chainSymbol}，放弃全页找链以免误选 USDC`, 'warning');
                diagnoseUSDTFloatFail(rowUsed, chainSymbol, tokenSymbol);
                log('已输出诊断到控制台。看报错：F12→Console，红色=错误、黄色=警告；点左上「Default levels」只勾选 Errors 可只看错误；若见 504/CORS/WebSocket 等红字多为网页或网络问题。', 'info');
                throw new Error(`${tokenSymbol} 行多链浮层未就绪，请重试`);
            }
            log('fallback: 点行并全页找链', 'info');
            await nativeClick(rowUsed);
        } else {
            await clickElementAtCenter(targetRow);
        }
        
        const targetRowRect = rowUsed.getBoundingClientRect();
        await sleep(CONFIG.UI_STABLE_WAIT);
        
        let chainButton = null;
        const chainSearchStart = Date.now();
        while (Date.now() - chainSearchStart < CONFIG.CHAIN_SEARCH_TIMEOUT) {
            const chainButtons = document.querySelectorAll('div[class*="cursor-pointer"]');
            for (const btn of chainButtons) {
                const rect = btn.getBoundingClientRect();
                const classes = btn.className || '';
                if (rect.top > targetRowRect.top && matchesChainName(btn, chainSymbol) &&
                    (classes.includes('p-1') || classes.includes('hover:bg-genius-blue')) &&
                    btn.offsetParent !== null) {
                    chainButton = btn;
                    log(`✓ 找到 ${chainSymbol} 链按钮`, 'success');
                    break;
                }
            }
            if (chainButton) break;
            await sleep(CONFIG.UI_STABLE_WAIT);
        }
        
        if (chainButton) {
            await clickElement(chainButton);
            log(`✓ 已选择 ${chainSymbol} 链`, 'success');
            await waitForDialogClose(CONFIG.DIALOG_CLOSE_TIMEOUT);
        } else {
            log(`⚠️ 未找到 ${chainSymbol} 链按钮`, 'warning');
        }
        
        log(`✓ ${tokenSymbol} (${chainSymbol} 链) 已选择`, 'success');
        return true;
    }

    // 检查标签是否已激活
    const isTabActive = (tab) => {
        if (!tab) return false;
        const classes = tab.className || '';
        return classes.includes('text-genius-cream') && !classes.includes('text-genius-cream/60');
    };
    
    // 通用点击标签函数
    async function clickTab(tabName, findFn) {
        // 先检查标签是否已激活
        const initialTab = findFn();
        if (isTabActive(initialTab)) {
            log(`✓ ${tabName} 标签已激活`, 'success');
            return;
        }
        
        // 点击标签
        if (initialTab) {
            await clickElement(initialTab);
        }
        
        const startTime = Date.now();
        while (Date.now() - startTime < CONFIG.TAB_ACTIVATE_TIMEOUT) {
            const tab = findFn();
            if (isTabActive(tab)) {
                log(`✓ ${tabName} 标签已激活`, 'success');
                await sleep(CONFIG.UI_STABLE_WAIT);
                return;
            }
            await sleep(CONFIG.POLL_INTERVAL);
        }
        
        log(`⚠️ ${tabName} 标签激活超时`, 'warning');
    }
    
    // 点击 Saved 标签
    async function clickSaved() {
        await clickTab('Saved', findSavedTab);
    }
    
    // 点击 Stable 标签
    async function clickStable() {
        await clickTab('Stable', findStableTab);
    }
    
    // 点击 Gas 标签
    async function clickGas() {
        await clickTab('Gas', findGasTab);
    }

    /**
     * 根据代币类型选择标签并选择代币
     * @param {string} tokenSymbol - 代币符号
     * @param {string} chainSymbol - 链符号
     * @param {Object} options - 选项
     * @param {boolean} options.isBaseToken - 是否为基础币种
     * @param {boolean} options.requireChain - 是否需要链选择（用于稳定币模式）
     * @returns {Promise<boolean>}
     */
    async function selectTokenByType(tokenSymbol, chainSymbol, options = {}) {
        const { isBaseToken = false, requireChain = false } = options;
        const tokenUpper = tokenSymbol.toUpperCase();
        
        if (NATIVE_TOKENS.includes(tokenUpper)) {
            // 原生代币（BNB, SOL, ETH, AVAX, HYPE, SUI, POL, S）在 Gas 框中查找
            await clickGas();
            if (!checkRunning()) return false;
            
            // ETH 需要多链选择
            if (tokenUpper === 'ETH' && ETH_CHAINS.includes(chainSymbol)) {
                await selectTokenWithChain(tokenSymbol, chainSymbol);
            } else {
                // 其他原生代币直接选择（通常不需要链选择）
                await selectToken(tokenSymbol);
            }
        } else if (tokenUpper === 'USDT') {
            // USDT 在 Stable 中
            await clickStable();
            if (!checkRunning()) return false;
            await selectTokenWithChain(tokenSymbol, chainSymbol);
        } else {
            // 其他代币（如 USDC、KOGE、FIGHT 等）在 Saved 中
            await clickSaved();
            if (!checkRunning()) return false;
            
            // 判断是否需要链选择
            if (requireChain || (isBaseToken && chainSymbol)) {
                await selectTokenWithChain(tokenSymbol, chainSymbol);
            } else {
                await selectToken(tokenSymbol);
            }
        }
        
        return true;
    }

    // 查找金额按钮（25%, 50%, MAX）
    const findAmountButton = (amountText) => {
        const match = (amountText || 'MAX').trim().toUpperCase();
        return Array.from(document.querySelectorAll('button'))
            .filter(b => b.offsetParent !== null)
            .find(b => (b.innerText || b.textContent || '').trim().toUpperCase() === match) || null;
    };
    
    // 点击金额按钮（支持 25%, 50%, MAX）
    async function clickAmount(amountText = 'MAX') {
        log(`查找 ${amountText} 按钮...`, 'info');
        
        let btn = findAmountButton(amountText);
        
        if (btn && btn.disabled) {
            log(`${amountText} 按钮被禁用，等待...`, 'warning');
            await sleep(CONFIG.CLOSE_DIALOG_WAIT);
            btn = findAmountButton(amountText);
        }
        
        if (!btn || btn.disabled) {
            // 如果找不到指定的，尝试 MAX
            if (amountText !== 'MAX') {
                log(`找不到 ${amountText}，尝试 MAX...`, 'warning');
                btn = findAmountButton('MAX');
            }
            if (!btn || btn.disabled) {
                throw new Error(`${amountText} 按钮不可用`);
            }
        }
        
        await clickElement(btn);
        log(`✓ ${amountText} 已点击`, 'success');
        await randomSleep(CONFIG.waitAfterMax);
    }

    /**
     * 点击第二个 Choose 按钮（接收方）
     * @returns {Promise<boolean>} 是否成功
     */
    async function clickSecondChoose() {
        if (!checkRunning()) return false;
        
        const chooseBtns = findChooseButtons();
        if (chooseBtns.length === 0) {
            log('⚠️ 未找到第二个 Choose 按钮', 'warning');
            return false;
        }
        
        log('点击第二个 Choose (接收)', 'info');
        await clickElement(chooseBtns[0]);
        
        const dialogOpened = await waitForDialogOpen(CONFIG.DIALOG_OPEN_TIMEOUT);
        if (!dialogOpened) {
            log('⚠️ 弹窗未打开', 'warning');
            return false;
        }
        
        return true;
    }

    // ==================== 滑点保护 ====================
    
    /**
     * 获取代币价格
     * @returns {Object} {price1, price2} 代币1和代币2的价格
     */
    function getPrices() {
        try {
            // 查找所有价格显示元素（包含 $ 符号的 div）
            const priceDivs = document.querySelectorAll('div.text-genius-cream\\/60');
            
            let price1 = null;
            let price2 = null;
            
            priceDivs.forEach(div => {
                const text = div.textContent.trim();
                if (text.startsWith('$')) {
                    const value = parseFloat(text.replace('$', '').replace(',', ''));
                    if (!isNaN(value) && value > 0) {
                        // 检查这个价格属于哪个代币（通过父元素中的 input 判断）
                        const parent = div.closest('div.flex.flex-col');
                        if (parent) {
                            const input = parent.querySelector('input');
                            if (input) {
                                if (input.disabled) {
                                    price2 = value; // 代币2（接收方）
                                } else {
                                    price1 = value; // 代币1（发送方）
                                }
                            }
                        }
                    }
                }
            });
            
            return { price1, price2 };
        } catch (e) {
            log(`⚠️ 获取价格失败: ${e.message}`, 'warning');
            return { price1: null, price2: null };
        }
    }
    
    /**
     * 计算滑点百分比
     * @param {number} price1 - 代币1价格
     * @param {number} price2 - 代币2价格
     * @returns {number|null} 滑点百分比，如果无法计算则返回 null
     */
    function calculateSlippage(price1, price2) {
        if (!price1 || !price2 || price1 === 0) return null;
        const slippage = Math.abs(price1 - price2) / price1 * 100;
        return Math.round(slippage * 100) / 100; // 保留2位小数
    }
    
    /**
     * 点击 Refresh 按钮刷新报价
     * @returns {Promise<boolean>} 是否成功
     */
    async function clickRefreshButton() {
        const refreshBtn = Array.from(document.querySelectorAll('button')).find(btn => {
            return btn.textContent.includes('Refresh') || 
                   btn.querySelector('svg.lucide-refresh-ccw');
        });
        
        if (refreshBtn) {
            await clickElement(refreshBtn);
            log('🔄 点击 Refresh 刷新报价', 'info');
            await fixedRandomSleep(CONFIG.REFRESH_WAIT_MS);
            return true;
        }
        return false;
    }
    
    // 等待价格元素出现
    /**
     * 等待价格元素出现并获取价格
     * @param {number} timeout - 超时时间（毫秒）
     * @returns {Promise<Object>} {price1, price2} 代币价格
     */
    async function waitForPrices(timeout = CONFIG.PRICE_LOAD_TIMEOUT) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            const { price1, price2 } = getPrices();
            if (price1 !== null && price2 !== null) {
                return { price1, price2 };
            }
            await sleep(CONFIG.UI_STABLE_WAIT);
        }
        return { price1: null, price2: null };
    }
    
    // 检测滑点并处理（返回 true 表示可以继续交易，false 表示需要刷新页面）
    /**
     * 检查滑点并处理
     * 如果滑点过高，会点击 Refresh 按钮，最多3次后刷新页面
     * @returns {Promise<boolean>} 是否通过滑点检测
     */
    async function checkSlippageAndHandle() {
        if (!enableSlippageProtection) return true;
        
        const maxRetries = 3;
        
        for (let retry = 0; retry < maxRetries; retry++) {
            // 等待价格元素出现（最多等待 10 秒）
            log('等待价格加载...', 'info');
            const { price1, price2 } = await waitForPrices(CONFIG.PRICE_LOAD_TIMEOUT);
            
            // 价格加载超时或无法获取
            if (price1 === null || price2 === null) {
                log(`⚠️ 价格加载超时 (${retry + 1}/${maxRetries})`, 'warning');
                
                if (retry < maxRetries - 1) {
                    // 还有重试机会，点击 Refresh
                    const refreshed = await clickRefreshButton();
                    if (!refreshed) {
                        log('⚠️ 未找到 Refresh 按钮', 'warning');
                    }
                    continue; // 继续下一次循环
                }
                // 最后一次仍然超时，触发页面刷新
                log(`❌ 连续 ${maxRetries} 次价格加载失败，刷新页面重新开始`, 'error');
                return false;
            }
            
            const slippage = calculateSlippage(price1, price2);
            
            if (slippage === null) {
                log('⚠️ 无法计算滑点，跳过检测', 'warning');
                return true;
            }
            
            if (slippage <= maxSlippagePercent) {
                log(`✓ 滑点检测通过: ${slippage}% ≤ ${maxSlippagePercent}% ($${price1.toFixed(2)} → $${price2.toFixed(2)})`, 'success');
                return true;
            }
            
            // 滑点过大
            log(`⚠️ 滑点过大: ${slippage}% > ${maxSlippagePercent}% ($${price1.toFixed(2)} → $${price2.toFixed(2)})`, 'warning');
            
            if (retry < maxRetries - 1) {
                // 还有重试机会，点击 Refresh
                const refreshed = await clickRefreshButton();
                if (!refreshed) {
                    log('⚠️ 未找到 Refresh 按钮', 'warning');
                }
                log(`刷新报价中... (${retry + 1}/${maxRetries})`, 'info');
            }
        }
        
        // 连续 3 次滑点过大，触发页面刷新
        log(`❌ 连续 ${maxRetries} 次滑点过大，刷新页面重新开始`, 'error');
        return false; // 返回 false 触发页面刷新逻辑
    }

    // 点击 Confirm 按钮 - 等待按钮出现后点击
    /**
     * 检测页面是否有错误消息
     * @returns {boolean} 是否有错误
     */
    const hasError = () => {
        // 查找常见的错误提示元素
        const errorSelectors = [
            'div[class*="error"]',
            'div[class*="Error"]',
            'div[class*="danger"]',
            'div[class*="Danger"]',
            'span[class*="error"]',
            'span[class*="Error"]'
        ];
        
        for (const selector of errorSelectors) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
                const text = (el.textContent || '').toLowerCase();
                if (text.includes('error') || text.includes('失败') || text.includes('错误') || 
                    text.includes('failed') || text.includes('revert')) {
                    if (el.offsetParent !== null) {
                        return true;
                    }
                }
            }
        }
        return false;
    };
    
    /**
     * 点击 Confirm 按钮
     * 包含持续检测、观察期验证、错误处理和自动重试机制
     * @returns {Promise<string|boolean>} REFRESH_PAGE | true | false
     */
    async function clickConfirm() {
        log('等待 Confirm 按钮出现...', 'info');
        
        let refreshCount = 0;
        const maxRefreshAttempts = 3;
        const maxWaitTime = CONFIG.CONFIRM_WAIT_TIMEOUT;
        const observationPeriod = CONFIG.OBSERVATION_PERIOD;
        const startTime = Date.now();
        
        let buttonDisappearedTime = null; // 按钮消失的时间
        let hasClicked = false; // 是否已点击过
        let observationEndLogged = false; // 是否已打印观察期结束日志
        let lastLogTime = 0; // 上次打印日志的时间（用于降低日志频率）
        const logInterval = 2000; // 日志间隔（2秒）
        
        while (Date.now() - startTime < maxWaitTime) {
            if (!checkRunning()) return false;
            
            // 优先检查1: 交易确认弹窗是否出现（最可靠的点击成功标志）
            const closeBtn = findCloseButton();
            if (closeBtn && closeBtn.offsetParent !== null) {
                log('✓ 交易确认弹窗已出现，点击成功', 'success');
                return true;
            }
            
            // 检查是否有错误状态（优先处理错误）
            if (hasError()) {
                log('❌ 检测到错误状态，立即处理', 'error');
                
                if (refreshCount < maxRefreshAttempts) {
                    refreshCount++;
                    log(`🔄 尝试刷新报价 (${refreshCount}/${maxRefreshAttempts})...`, 'info');
                    
                    try {
                        await clickRefreshButton();
                        await fixedRandomSleep(CONFIG.REFRESH_WAIT_MS);
                        
                        // 重置状态
                        buttonDisappearedTime = null;
                        hasClicked = false;
                        observationEndLogged = false;
                        
                        // 刷新后检查错误是否消失
                        await sleep(500);
                        if (hasError()) {
                            log('⚠️ 刷新后仍有错误，继续尝试...', 'warning');
                            continue; // 继续循环，下次会再次检测错误
                        } else {
                            log('✓ 刷新后错误已消失，继续检测按钮', 'success');
                            continue; // 刷新后重新检测按钮
                        }
                    } catch (e) {
                        log(`⚠️ 刷新失败: ${e.message}`, 'warning');
                        // 刷新失败，继续尝试或触发页面刷新
                        if (refreshCount >= maxRefreshAttempts) {
                            log('❌ 刷新失败且达到最大尝试次数，触发页面刷新', 'error');
                            return 'REFRESH_PAGE';
                        }
                    }
                } else {
                    log('❌ 刷新 3 次后仍有错误，触发页面刷新', 'error');
                    return 'REFRESH_PAGE'; // 特殊返回值，触发页面刷新
                }
            }
            
            // 检测 Confirm 按钮状态
            const confirmBtn = findConfirmButton();
            const buttonExists = confirmBtn && confirmBtn.offsetParent !== null;
            
            if (buttonExists) {
                // 按钮存在
                if (buttonDisappearedTime !== null) {
                    // 按钮重新出现了（在观察期内或观察期后）
                    log('⚠️ Confirm 按钮重新出现，立即点击', 'warning');
                    buttonDisappearedTime = null; // 重置观察期
                    hasClicked = false; // 重置点击状态，允许重新点击
                    observationEndLogged = false; // 重置日志标志
                }
                
                // 检查按钮是否可点击
                const isDisabled = confirmBtn.disabled || 
                                   confirmBtn.classList.contains('disabled') ||
                                   confirmBtn.style.pointerEvents === 'none';
                
                // 检查按钮是否在 loading 状态（有 animate-spin 类）
                const isLoading = confirmBtn.querySelector('svg.animate-spin') !== null ||
                                 confirmBtn.querySelector('.animate-spin') !== null;
                
                // 读取按钮信息（用于调试）- 只在首次点击时打印
                if (!hasClicked) {
                    const buttonText = (confirmBtn.innerText || '').trim();
                    const buttonInfo = {
                        text: buttonText,
                        disabled: isDisabled,
                        loading: isLoading,
                        visible: confirmBtn.offsetParent !== null
                    };
                    log(`📋 Confirm 按钮信息: ${JSON.stringify(buttonInfo)}`, 'info');
                }
                
                if (!isDisabled && !isLoading) {
                    // 按钮可点击，立即点击（无论之前是否点击过）
                    try {
                        await clickElement(confirmBtn);
                        const buttonText = (confirmBtn.innerText || '').trim();
                        log(`✓ Confirm 已点击 (按钮文本: "${buttonText}")`, 'success');
                        hasClicked = true;
                        buttonDisappearedTime = null; // 重置观察期
                        observationEndLogged = false; // 重置日志标志
                        await sleep(200); // 等待观察按钮状态变化
                    } catch (e) {
                        log(`⚠️ 点击 Confirm 失败: ${e.message}`, 'warning');
                    }
                } else if (isLoading) {
                    // 按钮正在 loading，等待处理完成（降低日志频率）
                    const now = Date.now();
                    if (now - lastLogTime >= logInterval) {
                        log('⏳ Confirm 按钮正在处理中...', 'info');
                        lastLogTime = now;
                    }
                    await sleep(300); // UI 稳定等待（保持较短时间）
                    continue;
                } else {
                    // 按钮被禁用，等待启用（降低日志频率）
                    const now = Date.now();
                    if (now - lastLogTime >= logInterval) {
                        log(`⏳ Confirm 按钮被禁用，等待启用...`, 'info');
                        lastLogTime = now;
                    }
                    await sleep(200);
                    continue;
                }
            } else {
                // 按钮不存在（已消失）
                if (buttonDisappearedTime === null) {
                    // 第一次检测到按钮消失，开始观察期
                    buttonDisappearedTime = Date.now();
                    log('⏳ Confirm 按钮已消失，进入观察期...', 'info');
                    observationEndLogged = false;
                } else {
                    // 在观察期内
                    const disappearedDuration = Date.now() - buttonDisappearedTime;
                    
                    if (disappearedDuration >= observationPeriod) {
                        // 观察期结束，按钮仍消失
                        // 只在第一次检测到观察期结束时打印日志
                        if (!observationEndLogged) {
                            log('⚠️ 观察期结束，按钮仍消失，继续检测确认弹窗...', 'warning');
                            observationEndLogged = true;
                        }
                        // 继续循环检测：确认弹窗、按钮重新出现、错误状态
                        // 不打印重复日志
                    }
                }
            }
            
            // 短暂等待后继续检测
            await sleep(200);
        }
        
        // 超时处理
        log('⚠️ Confirm 按钮等待超时，检查最终状态...', 'warning');
        
        // 优先检查确认弹窗
        const finalCloseBtn = findCloseButton();
        if (finalCloseBtn && finalCloseBtn.offsetParent !== null) {
            log('✓ 交易确认弹窗已出现，点击成功', 'success');
            return true;
        }
        
        // 检查是否有错误（优先处理错误）
        if (hasError()) {
            log('❌ 超时且检测到错误状态，触发页面刷新', 'error');
            return 'REFRESH_PAGE';
        }
        
        // 检查按钮状态
        const finalBtn = findConfirmButton();
        if (finalBtn && finalBtn.offsetParent !== null) {
            // 按钮还在，尝试最后一次点击
            log('⚠️ 超时但按钮仍在，尝试最后一次点击...', 'warning');
            try {
                const isDisabled = finalBtn.disabled || 
                                   finalBtn.classList.contains('disabled') ||
                                   finalBtn.style.pointerEvents === 'none';
                const isLoading = finalBtn.querySelector('svg.animate-spin') !== null ||
                                 finalBtn.querySelector('.animate-spin') !== null;
                
                if (!isDisabled && !isLoading) {
                    await clickElement(finalBtn);
                    log('✓ 最后一次点击成功，继续等待确认', 'success');
                    // 再等待一下确认弹窗
                    await sleep(2000);
                    const closeBtnAfter = findCloseButton();
                    if (closeBtnAfter && closeBtnAfter.offsetParent !== null) {
                        return true;
                    }
                }
            } catch (e) {
                log(`⚠️ 最后一次点击失败: ${e.message}`, 'warning');
            }
            // 按钮还在但无法点击，返回 false 触发重试
            return false;
        } else {
            // 按钮已消失，可能成功（但确认弹窗未出现）
            log('⚠️ 超时且按钮已消失，但确认弹窗未出现', 'warning');
            // 返回 false，让调用方决定如何处理（可能需要刷新）
            return false;
        }
    }

    // 等待交易确认并关闭弹窗
    async function waitForConfirmationAndClose() {
        log('等待交易确认...', 'info');
        
        // 等待 Close 按钮出现
        for (let i = 0; i < 60; i++) {
            const closeBtn = findCloseButton();
            if (closeBtn) {
                await randomSleep([1000, 1500]);
                await clickElement(closeBtn);
                log('✓ 关闭交易完成弹窗', 'success');
                await randomSleep(CONFIG.waitAfterClose);
                return true;
            }
            await sleep(1000);
        }
        
        log('⚠️ 等待确认超时', 'warning');
        return false;
    }

    /**
     * 执行滑点检测、Confirm 点击和等待确认
     * @param {string} tradeDirection - 交易方向描述（用于日志，如 "USDC → KOGE"）
     * @returns {Promise<string|boolean>} SLIPPAGE_FAIL | REFRESH_PAGE | true | false
     */
    async function executeSlippageCheckAndConfirm(tradeDirection) {
        if (!checkRunning()) return false;
        
        // 短暂等待 UI 更新（价格会在滑点检测中等待）
        await sleep(CONFIG.UI_STABLE_WAIT);
        
        // 滑点检测
        const slippageOk = await checkSlippageAndHandle();
        if (!slippageOk) {
            return 'SLIPPAGE_FAIL';
        }
        
        if (!checkRunning()) return false;
        
        // 点击 Confirm
        const confirmResult = await clickConfirm();
        if (!checkRunning()) return false;
        
        if (confirmResult === 'REFRESH_PAGE') {
            return 'REFRESH_PAGE';
        }
        
        if (confirmResult !== true) {
            return false;
        }
        
        // 等待确认并关闭
        await waitForConfirmationAndClose();
        log(`✓ ${tradeDirection} 交易完成`, 'success');
        
        return true;
    }

    // ==================== 主交易逻辑 ====================
    // 步骤形态统一：选第一个币 → 点金额 → 点第二个 Choose → 选第二个币 → 滑点/Confirm。
    // 稳定币卖/买由 executeStableModeSell / executeStableModeBuy 实现；普通模式由下方两个函数实现。

    /**
     * 从已打开的弹窗执行 目标代币 → 基础币种 交易（普通模式卖出，与 executeStableModeSell 步骤对应）
     * @param {string} amountText - 金额选项（25%, 50%, MAX）
     * @returns {Promise<string|boolean>} SLIPPAGE_FAIL | REFRESH_PAGE | true | false
     */
    async function executeTargetToBaseFromDialog(amountText = 'MAX') {
        log(`========== ${targetToken} → ${baseToken} (${amountText}) ==========`, 'info');
        
        if (!checkRunning()) return false;
        
        // 1. 选择目标代币（第一个 Choose：弹窗默认显示 Saved，无需点击标签）
        // 选择了目标链时，第一个 Choose 仍从 Saved 选；第二个 Choose 在 Stable 中选目标代币+链
        if (targetChain && targetChain.trim()) {
            // 目标代币在 Stable 中（如 USDT）- 但第一个 Choose 从 Saved 默认列表选择
            await selectTokenByChain(targetToken, targetChain);
        } else {
            // 目标代币在 Saved 中（如 KOGE）
            await selectToken(targetToken);
        }
        if (!checkRunning()) return false;
        // 等待 Choose 按钮重新出现（弹窗关闭后）
        await waitForElement(() => findChooseButtons()[0], CONFIG.DIALOG_OPEN_TIMEOUT);
        await sleep(300); // UI 稳定等待（保持较短时间） // 短暂等待 UI 稳定
        
        // 2. 点击金额按钮
        await clickAmount(amountText);
        if (!checkRunning()) return false;
        
        // 3. 点击第二个 Choose
        if (!await clickSecondChoose()) {
            return false;
        }
        if (!checkRunning()) return false;
        
        // 4. 根据基础币种类型选择标签，然后选择基础币种（第二个 Choose：需要点击链按钮）
        await selectTokenByType(baseToken, baseChain, { isBaseToken: true, requireChain: true });
        if (!checkRunning()) return false;
        
        // 5. 执行滑点检测、Confirm 和等待确认
        const result = await executeSlippageCheckAndConfirm(`${targetToken} → ${baseToken}`);
        return result;
    }

    /**
     * 从已打开的弹窗执行 基础币种 → 目标代币 交易（普通模式买入，与 executeStableModeBuy 步骤对应）
     * @param {string} amountText - 金额选项（25%, 50%, MAX）
     * @returns {Promise<string|boolean>} SLIPPAGE_FAIL | REFRESH_PAGE | true | false
     */
    async function executeBaseToTargetFromDialog(amountText = 'MAX') {
        log(`========== ${baseToken} → ${targetToken} (${amountText}) ==========`, 'info');
        
        if (!checkRunning()) return false;
        
        // 1. 选择基础币种（第一个 Choose：弹窗默认显示 Saved，无需点击标签）
        await selectTokenByChain(baseToken, baseChain);
        if (!checkRunning()) return false;
        // 等待 Choose 按钮重新出现
        await waitForElement(() => findChooseButtons()[0], CONFIG.DIALOG_OPEN_TIMEOUT);
        await sleep(300); // UI 稳定等待（保持较短时间）
        
        // 2. 点击金额按钮
        await clickAmount(amountText);
        if (!checkRunning()) return false;
        
        // 3. 点击第二个 Choose
        if (!await clickSecondChoose()) {
            return false;
        }
        if (!checkRunning()) return false;
        
        // 4. 根据目标代币类型选择标签，然后选择目标代币
        await selectTokenByType(targetToken, targetChain, { 
            isBaseToken: false, 
            requireChain: !!(targetChain && targetChain.trim()) 
        });
        if (!checkRunning()) return false;
        
        // 5. 执行滑点检测、Confirm 和等待确认
        const result = await executeSlippageCheckAndConfirm(`${baseToken} → ${targetToken}`);
        return result;
    }

    /**
     * 执行稳定币模式卖出操作
     * @param {Object} detection - 代币检测结果
     * @returns {Promise<string|boolean>} 交易结果
     */
    async function executeStableModeSell(detection) {
        // 找到目标代币且有对应链，执行卖出
        log(`📍 [稳定币] 检测到 ${targetToken} (${targetChain} 链)，执行 ${targetToken} → ${baseToken} (MAX)`, 'info');
        
        // 1. 直接点击该行来选择目标代币
        if (detection.targetRowWithChain) {
            await clickElement(detection.targetRowWithChain);
            await randomSleep(CONFIG.waitAfterClick);
        }
        if (!checkRunning()) return false;
        
        // 2. 选择 MAX 金额
        await clickAmount('MAX');
        if (!checkRunning()) return false;
        
        // 3. 点击第二个 Choose（选择第一个代币后，只剩一个 Choose 按钮）
        if (!await clickSecondChoose()) {
            log('⚠️ 未找到第二个 Choose 按钮', 'warning');
            return false;
        }
        if (!checkRunning()) return false;
        
        // 4. 根据基础币种类型选择标签，然后选择基础币种 + 对应链
        await selectTokenByType(baseToken, baseChain, { isBaseToken: true, requireChain: true });
        if (!checkRunning()) return false;
        
        // 5. 执行滑点检测、Confirm 和等待确认
        return await executeSlippageCheckAndConfirm(`${targetToken} → ${baseToken}`);
    }

    /**
     * 执行稳定币模式买入操作
     * @param {string} amountText - 金额选项（25%, 50%, MAX）
     * @returns {Promise<string|boolean>} 交易结果
     */
    async function executeStableModeBuy(amountText) {
        // 没有目标代币或没有对应链，用基础币种买入
        log(`📍 [稳定币] 无 ${targetToken} (${targetChain} 链)，执行 ${baseToken} → ${targetToken} (${amountText})`, 'info');
        
        // 弹窗已经打开，直接在当前弹窗中选择基础币种，不需要重新打开
        // 1. 选择基础币种（第一个 Choose：弹窗已经打开）
        await selectTokenByChain(baseToken, baseChain);
        if (!checkRunning()) return false;
        // 等待 Choose 按钮重新出现
        await waitForElement(() => findChooseButtons()[0], CONFIG.DIALOG_OPEN_TIMEOUT);
        await sleep(300); // UI 稳定等待（保持较短时间）
        
        // 2. 点击金额按钮
        await clickAmount(amountText);
        if (!checkRunning()) return false;
        
        // 3. 点击第二个 Choose
        if (!await clickSecondChoose()) {
            return false;
        }
        if (!checkRunning()) return false;
        
        // 4. 根据目标代币类型选择标签，然后选择目标代币
        await selectTokenByType(targetToken, targetChain, { 
            isBaseToken: false, 
            requireChain: !!(targetChain && targetChain.trim()) 
        });
        if (!checkRunning()) return false;
        
        // 5. 执行滑点检测、Confirm 和等待确认
        return await executeSlippageCheckAndConfirm(`${baseToken} → ${targetToken}`);
    }

    /**
     * 检测当前可用的代币（在弹窗打开后调用）
     * @returns {Object} 返回检测结果 {hasBaseToken, hasTarget, hasTargetWithChain, targetRowWithChain, rows}
     */
    const detectAvailableToken = () => {
        const rows = findTokenRows();
        let hasBaseToken = false;
        let hasTarget = false;
        let hasTargetWithChain = false;
        let targetRowWithChain = null;
        let targetCount = 0;
        
        for (const row of rows) {
            const text = row.textContent || '';
            
            // 检测基础币种
            const baseTokenUpper = baseToken.toUpperCase();
            if (text.toUpperCase().includes(baseTokenUpper) && !matchesTargetToken(text)) {
                hasBaseToken = true;
            }
            
            // 检测目标代币
            if (matchesTargetToken(text) && !text.toUpperCase().includes(baseTokenUpper)) {
                hasTarget = true;
                targetCount++;
                
                // 检测是否有对应的链（用于稳定币模式）
                if (targetChain && targetChain.trim()) {
                    const hasChain = hasChainInRow(row, targetChain);
                    if (hasChain) {
                        hasTargetWithChain = true;
                        targetRowWithChain = row;
                        log(`✓ 找到 ${targetToken} (${targetChain} 链)`, 'success');
                    }
                }
            }
        }
        
        // 调试信息：如果在稳定币模式下找到了目标代币但没有匹配到链
        if ((targetChain && targetChain.trim()) && hasTarget && !hasTargetWithChain) {
            log(`⚠️ 找到 ${targetCount} 个 ${targetToken}，但无 ${targetChain} 链匹配`, 'warning');
        }
        
        return { hasBaseToken, hasTarget, hasTargetWithChain, targetRowWithChain, rows };
    };

    /**
     * 主交易循环
     * 持续执行交易，直到达到限额或用户停止
     */
    async function executeSwapLoop() {
        if (window.botRunning) {
            log('脚本已在运行中！', 'warning');
            return;
        }

        window.botRunning = true;
        isRunning = true;
        try { localStorage.removeItem('tradegenius_user_stopped'); } catch (e) {}
        stats.startTime = Date.now();
        UI.setRunning(true);
        
        // 初始化每日统计
        initDailyStats();
        
        // 如果已达到限额，扩展目标（用户手动重启）
        if (stats.successfulSwaps >= todayTradeTarget) {
            extendDailyLimit();
        }

        log('🚀 自动交易启动！', 'success');
        
        // 显示当前模式和设置
        const modeText = (targetChain && targetChain.trim()) ? `稳定币模式 (${targetToken} 在 Stable)` : `普通模式 (${targetToken} 在 Saved)`;
        log(`📋 ${modeText}`, 'info');
        log(`📋 ${baseToken}链: ${baseChain} | 目标链: ${targetChain}`, 'info');
        log(`速率: ${speedMultiplier}x`, 'info');
        
        if (enableDailyLimit) {
            log(`📊 今日目标: ${todayTradeTarget} 笔 | 已完成: ${stats.successfulSwaps} 笔`, 'info');
        } else {
            log(`📊 无限制模式 | 已完成: ${stats.successfulSwaps} 笔`, 'info');
        }

        await sleep(1200);

        while (isRunning) {
            try {
                // 检查停止信号
                if (!checkRunning()) {
                    log('检测到停止信号，退出循环', 'info');
                    break;
                }
                
                // 检查页面状态是否正确
                if (!isOnTradePage()) {
                    log('⚠️ 页面 URL 不正确，正在导航到交易页面...', 'warning');
                    navigateToTradePage();
                    return;
                }
                
                // 检查每日限额
                if (checkDailyLimit()) {
                    break;
                }
                
                // 检查交易额限制（每 5 笔检查一次）
                if (await checkVolumeLimit()) {
                    break;
                }
                
                // 检查连续失败 - 3 次就刷新页面（若用户已停止则不再刷新重启）
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    log('⚠️ 连续失败 3 次，等待 5 秒后刷新页面...', 'warning');
                    await sleep(5000);
                    if (!checkRunning()) return;
                    refreshAndRestart();
                    return;
                }
                
                const progressText = enableDailyLimit 
                    ? `第 ${stats.successfulSwaps + 1}/${todayTradeTarget} 笔`
                    : `第 ${stats.successfulSwaps + 1} 笔 (无限制)`;
                log(`\n========== ${progressText} ==========`, 'info');

                // 先检查并关闭可能存在的弹窗
                const closeBtn = findCloseButton();
                if (closeBtn) {
                    await clickElement(closeBtn);
                    log('✓ 关闭已有弹窗', 'success');
                    await randomSleep(CONFIG.waitAfterClose);
                    if (!checkRunning()) break;
                    continue;
                }

                // 点击第一个 Choose 按钮
                const chooseBtns = findChooseButtons();
                if (chooseBtns.length === 0) {
                    // 检查是否在正确页面
                    if (!isOnTradePage()) {
                        log('⚠️ 不在交易页面，正在导航...', 'warning');
                        navigateToTradePage();
                        return;
                    }
                    log('⚠️ 未找到 Choose 按钮，等待页面加载...', 'warning');
                    consecutiveFailures++;
                    await sleep(CONFIG.RETRY_WAIT);
                    continue;
                }
                
                log('点击第一个 Choose 按钮', 'info');
                await clickElement(chooseBtns[0]);
                
                // 等待弹窗打开（最多 8 秒）
                const firstDialogOpened = await waitForDialogOpen(CONFIG.FIRST_DIALOG_OPEN_TIMEOUT);
                
                if (!firstDialogOpened) {
                    log('⚠️ 弹窗未打开，重试...', 'warning');
                    consecutiveFailures++;
                    await sleep(CONFIG.RETRY_WAIT);
                    continue;
                }
                
                // 弹窗打开后，等待代币列表加载（固定延迟）
                await fixedRandomSleep([800, 1200]);
                if (!checkRunning()) break;

                // 检测可用代币，决定交易方向
                let success = false;
                const amountText = selectAmount(); // 25%, 50%, MAX 随机
                
                if (targetChain && targetChain.trim()) {
                    // 【稳定币模式】复用 executeStableModeSell / executeStableModeBuy，与上文两个函数保持一致
                    log(`[稳定币模式] 检测可用代币...`, 'info');
                    await fixedRandomSleep([800, 1200]);
                    if (!checkRunning()) break;
                    const detection = detectAvailableToken();
                    if (detection.hasTargetWithChain) {
                        success = await executeStableModeSell(detection);
                        if (success === false) {
                            consecutiveFailures++;
                            continue;
                        }
                    } else {
                        success = await executeStableModeBuy(amountText);
                    }
                } else {
                    // 【普通模式】目标代币在 Saved 中（如 KOGE）
                    log(`[普通模式] 检测可用代币...`, 'info');
                    
                    // 使用固定延迟等待代币列表刷新
                    await fixedRandomSleep(CONFIG.TOKEN_LIST_WAIT);
                    if (!checkRunning()) break;
                    const { hasBaseToken, hasTarget } = detectAvailableToken();
                    
                    if (hasTarget) {
                        // 有目标代币，卖出
                        log(`📍 [普通] 检测到 ${targetToken}，执行 ${targetToken} → ${baseToken} (MAX)`, 'info');
                        success = await executeTargetToBaseFromDialog();
                    } else if (hasBaseToken) {
                        // 没有目标代币，用基础币种买入
                        log(`📍 [普通] 无 ${targetToken}，执行 ${baseToken} → ${targetToken} (${amountText})`, 'info');
                        success = await executeBaseToTargetFromDialog(amountText);
                    } else {
                        // 都没找到，尝试点击 Saved 标签
                        log(`⚠️ 未检测到 ${baseToken}/${targetToken}，尝试 Saved 标签...`, 'warning');
                        await clickSaved();
                        await sleep(CONFIG.UI_STABLE_WAIT);
                        
                        const saved = detectAvailableToken();
                        if (saved.hasTarget) {
                            log(`📍 Saved 中检测到 ${targetToken}，执行 ${targetToken} → ${baseToken} (MAX)`, 'info');
                            success = await executeTargetToBaseFromDialog();
                        } else if (saved.hasBaseToken) {
                            log(`📍 Saved 中检测到 ${baseToken}，执行 ${baseToken} → ${targetToken} (${amountText})`, 'info');
                            success = await executeBaseToTargetFromDialog(amountText);
                        } else {
                            log('❌ 未找到可交易的代币', 'error');
                            const dialog = getDialog();
                            if (dialog && dialog.getAttribute('role') === 'dialog') {
                                const closeX = dialog.querySelector('button[aria-label="Close"]') || 
                                              dialog.querySelector('button:has(svg)');
                                if (closeX) await clickElement(closeX);
                            }
                            consecutiveFailures++;
                            await sleep(CONFIG.CLOSE_DIALOG_WAIT);
                            continue;
                        }
                    }
                }

                // 处理滑点失败、Confirm 错误或超时 - 直接刷新页面重新开始
                if (success === 'SLIPPAGE_FAIL' || success === 'REFRESH_PAGE' || success === false) {
                    if (success === 'SLIPPAGE_FAIL') {
                        log('⚠️ 滑点保护触发，刷新页面重新开始...', 'warning');
                    } else if (success === 'REFRESH_PAGE') {
                        log('⚠️ Confirm 错误过多，刷新页面重新开始...', 'warning');
                    } else {
                        log('⚠️ Confirm 点击失败或超时，刷新页面重新开始...', 'warning');
                    }
                    await sleep(CONFIG.CLOSE_DIALOG_WAIT);
                    if (!checkRunning()) return;
                    refreshAndRestart();
                    return;
                }
                
                if (success === true) {
                    stats.successfulSwaps++;
                    consecutiveFailures = 0;
                    saveStats();
                    
                    if (enableDailyLimit) {
                        const remaining = todayTradeTarget - stats.successfulSwaps;
                        log(`✓ 交易完成！今日: ${stats.successfulSwaps}/${todayTradeTarget} (剩余 ${remaining})`, 'success');
                    } else {
                        log(`✓ 交易完成！今日已完成: ${stats.successfulSwaps} 笔`, 'success');
                    }
                    
                    if (!checkRunning()) break;
                    
                    // 随机等待
                    log('等待下一轮...', 'info');
                    await randomSleep(CONFIG.waitBetweenRounds);
                    
                    if (!checkRunning()) break;
                } else {
                    stats.failedSwaps++;
                    consecutiveFailures++;
                    saveStats();
                }

            } catch (error) {
                log(`❌ 错误: ${error.message}`, 'error');
                console.error(error);
                stats.failedSwaps++;
                consecutiveFailures++;
                saveStats();
                
                // 尝试关闭可能存在的弹窗
                try {
                    const dialog = document.querySelector('[role="dialog"]');
                    if (dialog) {
                        // 尝试多种方式关闭弹窗
                        const closeBtn = dialog.querySelector('button[aria-label="Close"]') ||
                                        dialog.querySelector('button:has(svg)') ||
                                        dialog.querySelector('button.absolute');
                        if (closeBtn) {
                            await clickElement(closeBtn);
                            log('已关闭弹窗', 'info');
                        } else {
                            // 按 ESC 键关闭
                            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                        }
                        await sleep(1000);
                    }
                } catch (e) {
                    // 忽略关闭弹窗的错误
                }
                
                await sleep(CONFIG.CLOSE_DIALOG_WAIT);
            }
        }

        window.botRunning = false;
        UI.setRunning(false);
        saveStats();
        log('🛑 自动交易已停止', 'warning');
    }

    function stopSwapLoop() {
        isRunning = false;
        window.botRunning = false;
        UI.setRunning(false);
        try { localStorage.setItem('tradegenius_user_stopped', 'true'); } catch (e) {}

        const runtime = stats.startTime ? Math.floor((Date.now() - stats.startTime) / 1000) : 0;
        const minutes = Math.floor(runtime / 60);
        const seconds = runtime % 60;

        log('🛑 停止交易', 'warning');
        log(`统计: 成功 ${stats.successfulSwaps} | 失败 ${stats.failedSwaps} | 运行 ${minutes}分${seconds}秒`, 'info');
    }

    // ==================== UI 界面 ====================
    // mount() 内逻辑块: Header | Controls(速率,限额,金额,交易对,链,预设,交易额,滑点,部署) | Preset | Log
    const UI = {
        root: null,
        statusDot: null,
        statusText: null,
        btnToggle: null,
        logEl: null,
        body: null,
        collapseBtn: null,
        isCollapsed: false,
        panelWidth: 340,
        panelMinWidth: 300,
        panelMaxWidth: 500,

        mount() {
            if (this.root) return;
            
            // 加载所有保存的设置
            loadAllSettings();
            
            // 加载面板大小设置
            const savedWidth = localStorage.getItem('tradeBotPanelWidth');
            if (savedWidth) this.panelWidth = parseInt(savedWidth) || 340;
            
            // 加载缩放状态
            const savedCollapsed = localStorage.getItem('tradeBotPanelCollapsed');
            this.isCollapsed = savedCollapsed === 'true';

            const root = document.createElement('div');
            root.id = 'trade-bot-panel';
            root.style.cssText = `
                position: fixed; left: 16px; top: 100px; z-index: 999999;
                width: ${this.panelWidth}px; min-width: ${this.panelMinWidth}px; max-width: ${this.panelMaxWidth}px;
                min-height: 300px; max-height: 80vh;
                font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
                border-radius: 12px; overflow: auto;
                background: linear-gradient(145deg, rgba(17,24,39,.98), rgba(30,41,59,.95));
                color: #e5e7eb;
                backdrop-filter: blur(12px);
                box-shadow: 0 10px 40px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.05);
                border: 1px solid rgba(255,255,255,.08);
                resize: both;
            `;

            // ---- UI: Header ----
            const header = document.createElement('div');
            header.style.cssText = `
                padding: 12px 14px; 
                display: flex; align-items: center; gap: 10px;
                background: linear-gradient(90deg, rgba(59,130,246,.1), transparent);
                border-bottom: 1px solid rgba(255,255,255,.08); 
                cursor: move;
            `;

            const dot = document.createElement('span');
            dot.style.cssText = `
                width: 10px; height: 10px; border-radius: 999px; flex-shrink: 0;
                background: #dc2626; 
                box-shadow: 0 0 8px rgba(220,38,38,.5);
            `;

            const titleWrap = document.createElement('div');
            titleWrap.style.cssText = `display: flex; flex-direction: column; line-height: 1.2; flex: 1; min-width: 0;`;

            const titleRow = document.createElement('div');
            titleRow.style.cssText = `display: flex; align-items: baseline; gap: 6px; min-width: 0;`;
            const title = document.createElement('div');
            title.textContent = 'Genius 现货自动交易';
            title.style.cssText = `font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`;
            const versionSpan = document.createElement('span');
            versionSpan.textContent = `v${SCRIPT_VERSION}`;
            versionSpan.style.cssText = `font-size: 10px; color: #64748b; opacity: .85; font-weight: 500; flex-shrink: 0;`;
            versionSpan.title = '脚本版本';
            titleRow.appendChild(title);
            titleRow.appendChild(versionSpan);

            const status = document.createElement('div');
            status.textContent = '已停止';
            status.style.cssText = `font-size: 11px; opacity: .75; color: #94a3b8;`;

            titleWrap.appendChild(titleRow);
            titleWrap.appendChild(status);

            const btn = document.createElement('button');
            btn.textContent = '开始交易';
            btn.style.cssText = `
                flex-shrink: 0; border: 0; cursor: pointer; color: white;
                background: linear-gradient(135deg, #16a34a, #15803d); 
                padding: 8px 16px; border-radius: 8px;
                font-weight: 700; font-size: 12px; transition: all .2s;
                box-shadow: 0 2px 8px rgba(22,163,74,.3);
            `;
            btn.onmouseover = () => { btn.style.transform = 'translateY(-1px)'; btn.style.boxShadow = '0 4px 12px rgba(22,163,74,.4)'; };
            btn.onmouseout = () => { btn.style.transform = 'translateY(0)'; btn.style.boxShadow = '0 2px 8px rgba(22,163,74,.3)'; };

            // 缩放按钮
            const collapseBtn = document.createElement('button');
            collapseBtn.textContent = this.isCollapsed ? '▼' : '▲';
            collapseBtn.title = this.isCollapsed ? '展开面板' : '收起面板';
            collapseBtn.style.cssText = `
                flex-shrink: 0; border: 0; cursor: pointer;
                background: rgba(255,255,255,.1);
                color: #94a3b8; padding: 6px 10px; border-radius: 6px;
                font-size: 10px; transition: all .2s;
            `;
            collapseBtn.onmouseover = () => { collapseBtn.style.background = 'rgba(255,255,255,.15)'; collapseBtn.style.color = '#e2e8f0'; };
            collapseBtn.onmouseout = () => { collapseBtn.style.background = 'rgba(255,255,255,.1)'; collapseBtn.style.color = '#94a3b8'; };

            header.appendChild(dot);
            header.appendChild(titleWrap);
            header.appendChild(btn);
            header.appendChild(collapseBtn);

            // ---- UI: Body + Controls ----
            const body = document.createElement('div');
            body.style.cssText = `padding: 12px; display: flex; flex-direction: column; gap: 10px;`;

            const controlsWrap = document.createElement('div');
            controlsWrap.style.cssText = `display: flex; flex-direction: column; gap: 8px;`;

            // Controls: 速率 + 每日限额
            const settingsRow = document.createElement('div');
            settingsRow.style.cssText = `display: flex; gap: 8px;`;

            // 速率选择卡片
            const speedCard = document.createElement('div');
            speedCard.style.cssText = `
                flex: 0 0 auto; width: 90px;
                padding: 8px; border-radius: 8px;
                background: linear-gradient(135deg, rgba(59,130,246,.12), rgba(59,130,246,.04));
                border: 1px solid rgba(59,130,246,.15);
            `;
            
            const speedTitle = document.createElement('div');
            speedTitle.textContent = '速率';
            speedTitle.style.cssText = `font-size: 9px; color: #93c5fd; margin-bottom: 5px; font-weight: 600; text-align: center;`;
            speedCard.appendChild(speedTitle);
            
            const speedBtnsWrap = document.createElement('div');
            speedBtnsWrap.style.cssText = `display: flex; gap: 3px;`;
            
            const speedBtnStyle = `
                flex: 1; border: 0; cursor: pointer; padding: 4px 0; border-radius: 4px;
                font-size: 10px; font-weight: 700; transition: all .15s;
            `;
            
            const speed1x = document.createElement('button');
            speed1x.textContent = '1x';
            speed1x.style.cssText = speedBtnStyle + `background: #3b82f6; color: white;`;
            
            const speed5x = document.createElement('button');
            speed5x.textContent = '5x';
            speed5x.style.cssText = speedBtnStyle + `background: rgba(255,255,255,.08); color: #94a3b8;`;
            
            const speed10x = document.createElement('button');
            speed10x.textContent = '10x';
            speed10x.style.cssText = speedBtnStyle + `background: rgba(255,255,255,.08); color: #94a3b8;`;
            
            const speedValues = [1, 5, 10];
            const speedButtons = [speed1x, speed5x, speed10x];
            
            const updateSpeedButtons = (activeValue) => {
                speedButtons.forEach((btn, idx) => {
                    const isActive = speedValues[idx] === activeValue;
                    btn.style.background = isActive ? '#3b82f6' : 'rgba(255,255,255,.08)';
                    btn.style.color = isActive ? 'white' : '#94a3b8';
                });
            };
            
            speed1x.onclick = () => { speedMultiplier = 1; updateSpeedButtons(1); log('速率: 1x (正常)', 'info'); saveAllSettings(); };
            speed5x.onclick = () => { speedMultiplier = 5; updateSpeedButtons(5); log('速率: 5x (快速)', 'info'); saveAllSettings(); };
            speed10x.onclick = () => { speedMultiplier = 10; updateSpeedButtons(10); log('速率: 10x (极速)', 'info'); saveAllSettings(); };
            
            speedBtnsWrap.appendChild(speed1x);
            speedBtnsWrap.appendChild(speed5x);
            speedBtnsWrap.appendChild(speed10x);
            speedCard.appendChild(speedBtnsWrap);
            
            // 根据保存的设置初始化速率按钮状态
            updateSpeedButtons(speedMultiplier);

            // 每日限额卡片
            const limitCard = document.createElement('div');
            limitCard.style.cssText = `
                flex: 1;
                padding: 8px 10px; border-radius: 8px;
                background: linear-gradient(135deg, rgba(16,185,129,.12), rgba(16,185,129,.04));
                border: 1px solid rgba(16,185,129,.15);
            `;
            
            // 标题行（包含勾选框）
            const limitTitleRow = document.createElement('div');
            limitTitleRow.style.cssText = `display: flex; align-items: center; gap: 5px; margin-bottom: 5px;`;
            
            const limitCheckbox = document.createElement('input');
            limitCheckbox.type = 'checkbox';
            limitCheckbox.checked = enableDailyLimit;
            limitCheckbox.style.cssText = `
                width: 12px; height: 12px; cursor: pointer; flex-shrink: 0;
                accent-color: #10b981;
            `;
            
            const limitTitle = document.createElement('span');
            limitTitle.textContent = '每日限额';
            limitTitle.style.cssText = `font-size: 9px; color: #6ee7b7; font-weight: 600;`;
            
            limitTitleRow.appendChild(limitCheckbox);
            limitTitleRow.appendChild(limitTitle);
            limitCard.appendChild(limitTitleRow);
            
            // 输入框行
            const limitInputRow = document.createElement('div');
            limitInputRow.style.cssText = `display: flex; align-items: center; gap: 4px;`;
            
            const limitInputStyle = `
                flex: 1; min-width: 0; max-width: 60px;
                border: 1px solid rgba(255,255,255,.15); border-radius: 4px;
                background: rgba(0,0,0,.25); color: #fff; padding: 5px 6px;
                font-size: 12px; font-weight: 700; outline: none; text-align: center;
            `;
            
            const limitMinInput = document.createElement('input');
            limitMinInput.type = 'number';
            limitMinInput.value = dailyLimitMin;
            limitMinInput.min = '1';
            limitMinInput.style.cssText = limitInputStyle;
            limitMinInput.disabled = !enableDailyLimit;
            
            const limitSeparator = document.createElement('span');
            limitSeparator.textContent = '~';
            limitSeparator.style.cssText = `font-size: 11px; color: #6ee7b7;`;
            
            const limitMaxInput = document.createElement('input');
            limitMaxInput.type = 'number';
            limitMaxInput.value = dailyLimitMax;
            limitMaxInput.min = '1';
            limitMaxInput.style.cssText = limitInputStyle;
            limitMaxInput.disabled = !enableDailyLimit;
            
            const limitUnit = document.createElement('span');
            limitUnit.textContent = '笔';
            limitUnit.style.cssText = `font-size: 10px; color: #6ee7b7; opacity: .8;`;
            
            limitInputRow.appendChild(limitMinInput);
            limitInputRow.appendChild(limitSeparator);
            limitInputRow.appendChild(limitMaxInput);
            limitInputRow.appendChild(limitUnit);
            limitCard.appendChild(limitInputRow);
            
            // 事件绑定
            const updateLimitInputsState = () => {
                const disabled = !limitCheckbox.checked;
                limitMinInput.disabled = disabled;
                limitMaxInput.disabled = disabled;
                limitMinInput.style.opacity = disabled ? '0.4' : '1';
                limitMaxInput.style.opacity = disabled ? '0.4' : '1';
            };
            
            limitCheckbox.onchange = () => {
                enableDailyLimit = limitCheckbox.checked;
                updateLimitInputsState();
                if (enableDailyLimit) {
                    log(`启用每日限额: ${dailyLimitMin}~${dailyLimitMax} 笔`, 'info');
                } else {
                    log('禁用每日限额，无限运行', 'info');
                    todayTradeTarget = 999999;
                }
                saveAllSettings();
            };
            
            limitMinInput.onchange = () => {
                dailyLimitMin = Math.max(1, parseInt(limitMinInput.value) || 1);
                limitMinInput.value = dailyLimitMin;
                if (dailyLimitMin > dailyLimitMax) {
                    dailyLimitMax = dailyLimitMin;
                    limitMaxInput.value = dailyLimitMax;
                }
                log(`限额范围: ${dailyLimitMin}~${dailyLimitMax} 笔`, 'info');
                saveAllSettings();
            };
            
            limitMaxInput.onchange = () => {
                dailyLimitMax = Math.max(1, parseInt(limitMaxInput.value) || 1);
                limitMaxInput.value = dailyLimitMax;
                if (dailyLimitMax < dailyLimitMin) {
                    dailyLimitMin = dailyLimitMax;
                    limitMinInput.value = dailyLimitMin;
                }
                log(`限额范围: ${dailyLimitMin}~${dailyLimitMax} 笔`, 'info');
                saveAllSettings();
            };
            
            // 初始化状态
            updateLimitInputsState();

            settingsRow.appendChild(speedCard);
            settingsRow.appendChild(limitCard);

            // Controls: 金额选项
            const amountRow = document.createElement('div');
            amountRow.style.cssText = `
                display: flex; align-items: center; gap: 8px;
                padding: 8px 10px; border-radius: 8px;
                background: linear-gradient(135deg, rgba(168,85,247,.1), rgba(168,85,247,.03));
                border: 1px solid rgba(168,85,247,.15);
            `;
            
            const amountTitle = document.createElement('span');
            amountTitle.textContent = '随机金额';
            amountTitle.style.cssText = `font-size: 9px; color: #c4b5fd; font-weight: 600; flex-shrink: 0;`;
            amountRow.appendChild(amountTitle);
            
            const amountBtnsWrap = document.createElement('div');
            amountBtnsWrap.style.cssText = `display: flex; gap: 6px; flex: 1;`;
            
            const amountBtnStyle = `
                flex: 1; border: 0; cursor: pointer; padding: 5px 8px; border-radius: 4px;
                font-size: 11px; font-weight: 700; transition: all .15s;
            `;
            
            const amountKeys = ['25%', '50%', 'MAX'];
            const amountButtons = {};
            
            const updateAmountButtonStyle = (btn, key) => {
                const isActive = amountOptions[key];
                btn.style.background = isActive ? '#a855f7' : 'rgba(255,255,255,.08)';
                btn.style.color = isActive ? 'white' : '#94a3b8';
                btn.style.boxShadow = isActive ? '0 2px 8px rgba(168,85,247,.3)' : 'none';
            };
            
            amountKeys.forEach(key => {
                const btn = document.createElement('button');
                btn.textContent = key;
                btn.style.cssText = amountBtnStyle;
                amountButtons[key] = btn;
                
                btn.onclick = () => {
                    // 切换选中状态
                    amountOptions[key] = !amountOptions[key];
                    
                    // 确保至少有一个选项被选中
                    const enabledCount = Object.values(amountOptions).filter(v => v).length;
                    if (enabledCount === 0) {
                        amountOptions[key] = true; // 不允许全部取消
                        log('⚠️ 至少需要选择一个金额选项', 'warning');
                    }
                    
                    updateAmountButtonStyle(btn, key);
                    
                    // 显示当前选中的选项
                    const enabled = Object.keys(amountOptions).filter(k => amountOptions[k]);
                    log(`金额选项: ${enabled.join(', ')}`, 'info');
                    saveAllSettings();
                };
                
                // 初始化按钮状态
                updateAmountButtonStyle(btn, key);
                amountBtnsWrap.appendChild(btn);
            });
            
            amountRow.appendChild(amountBtnsWrap);

            // Controls: 交易对
            const tokenRow = document.createElement('div');
            tokenRow.style.cssText = `
                display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
                padding: 8px 10px; border-radius: 8px;
                background: rgba(0,0,0,.2);
                border: 1px solid rgba(255,255,255,.05);
            `;
            
            // 基础币种输入框
            const baseTokenInput = document.createElement('input');
            baseTokenInput.type = 'text';
            baseTokenInput.value = baseToken;
            baseTokenInput.placeholder = 'USDC';
            baseTokenInput.style.cssText = `
                width: 60px; flex-shrink: 0;
                border: 1px solid rgba(255,255,255,.12); border-radius: 4px;
                background: rgba(0,0,0,.3); color: #60a5fa; padding: 4px 6px;
                font-size: 11px; font-weight: 700; outline: none;
                text-transform: uppercase; text-align: center;
            `;
            baseTokenInput.onfocus = () => { baseTokenInput.style.borderColor = '#60a5fa'; baseTokenInput.style.background = 'rgba(59,130,246,.08)'; };
            baseTokenInput.onblur = () => { 
                baseTokenInput.style.borderColor = 'rgba(255,255,255,.12)'; 
                baseTokenInput.style.background = 'rgba(0,0,0,.3)';
                // 自动保存
                const newBase = baseTokenInput.value.trim().toUpperCase();
                if (newBase && newBase !== baseToken) {
                    baseToken = newBase;
                    log(`基础币种: ${baseToken}`, 'info');
                    saveAllSettings();
                }
            };
            
            const tokenArrow = document.createElement('span');
            tokenArrow.textContent = '⇄';
            tokenArrow.style.cssText = `font-size: 12px; color: #64748b; font-weight: 600; flex-shrink: 0;`;
            
            // 目标代币输入框
            const tokenInput = document.createElement('input');
            tokenInput.type = 'text';
            tokenInput.value = targetToken;
            tokenInput.placeholder = 'KOGE';
            tokenInput.style.cssText = `
                width: 60px; flex-shrink: 0;
                border: 1px solid rgba(255,255,255,.12); border-radius: 4px;
                background: rgba(0,0,0,.3); color: #fbbf24; padding: 4px 6px;
                font-size: 11px; font-weight: 700; outline: none;
                text-transform: uppercase; text-align: center;
            `;
            tokenInput.onfocus = () => { tokenInput.style.borderColor = '#fbbf24'; tokenInput.style.background = 'rgba(251,191,36,.08)'; };
            tokenInput.onblur = () => { 
                tokenInput.style.borderColor = 'rgba(255,255,255,.12)'; 
                tokenInput.style.background = 'rgba(0,0,0,.3)';
                // 自动保存
                const newToken = tokenInput.value.trim().toUpperCase();
                if (newToken && newToken !== targetToken) {
                    targetToken = newToken;
                    log(`目标代币: ${targetToken}`, 'info');
                    saveAllSettings();
                }
            };
            
            const tokenApplyBtn = document.createElement('button');
            tokenApplyBtn.textContent = 'OK';
            tokenApplyBtn.style.cssText = `
                border: 0; cursor: pointer; padding: 4px 8px; border-radius: 4px; flex-shrink: 0;
                font-size: 10px; font-weight: 700; transition: all .15s;
                background: linear-gradient(135deg, #10b981, #059669); color: white;
            `;
            tokenApplyBtn.onmouseover = () => { tokenApplyBtn.style.transform = 'scale(1.05)'; };
            tokenApplyBtn.onmouseout = () => { tokenApplyBtn.style.transform = 'scale(1)'; };
            tokenApplyBtn.onclick = () => {
                const newBase = baseTokenInput.value.trim().toUpperCase();
                const newToken = tokenInput.value.trim().toUpperCase();
                if (newBase && newToken) {
                    baseToken = newBase;
                    targetToken = newToken;
                    title.textContent = 'Genius 现货自动交易';
                    log(`交易对: ${baseToken} ⇄ ${targetToken}`, 'success');
                    saveAllSettings();
                }
            };
            
            tokenRow.appendChild(baseTokenInput);
            tokenRow.appendChild(tokenArrow);
            tokenRow.appendChild(tokenInput);
            tokenRow.appendChild(tokenApplyBtn);

            // Controls: 链设置
            const chainRow = document.createElement('div');
            chainRow.style.cssText = `
                display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
                padding: 8px 10px; border-radius: 8px;
                background: rgba(0,0,0,.15);
                border: 1px solid rgba(255,255,255,.05);
            `;
            
            // 创建下拉菜单的样式
            const selectStyle = `
                border: 1px solid rgba(255,255,255,.12); border-radius: 4px;
                background: rgba(0,0,0,.3); color: #e5e7eb; padding: 3px 6px;
                font-size: 10px; font-weight: 600; outline: none; cursor: pointer;
            `;
            
            // 基础币种链选择
            const baseChainLabel = document.createElement('span');
            baseChainLabel.textContent = '基础链';
            baseChainLabel.style.cssText = `font-size: 9px; color: #60a5fa; font-weight: 600;`;
            
            const baseChainSelect = document.createElement('select');
            baseChainSelect.style.cssText = selectStyle;
            CHAIN_OPTIONS.forEach(chain => {
                const opt = document.createElement('option');
                opt.value = chain;
                opt.textContent = chain;
                if (chain === baseChain) opt.selected = true;
                baseChainSelect.appendChild(opt);
            });
            baseChainSelect.onchange = () => {
                baseChain = baseChainSelect.value;
                log(`${baseToken} 链: ${baseChain}`, 'info');
                saveAllSettings();
            };
            
            // 目标代币链选择
            const targetChainLabel = document.createElement('span');
            targetChainLabel.textContent = '目标链';
            targetChainLabel.style.cssText = `font-size: 9px; color: #fbbf24; font-weight: 600; margin-left: 6px;`;
            
            const targetChainSelect = document.createElement('select');
            targetChainSelect.style.cssText = selectStyle;
            CHAIN_OPTIONS.forEach(chain => {
                const opt = document.createElement('option');
                opt.value = chain;
                opt.textContent = chain;
                if (chain === targetChain) opt.selected = true;
                targetChainSelect.appendChild(opt);
            });
            targetChainSelect.onchange = () => {
                targetChain = targetChainSelect.value;
                log(`目标代币链: ${targetChain}`, 'info');
                saveAllSettings();
            };
            
            chainRow.appendChild(baseChainLabel);
            chainRow.appendChild(baseChainSelect);
            chainRow.appendChild(targetChainLabel);
            chainRow.appendChild(targetChainSelect);
            
            controlsWrap.appendChild(settingsRow);
            controlsWrap.appendChild(amountRow);
            controlsWrap.appendChild(tokenRow);
            controlsWrap.appendChild(chainRow);

            // ---- UI: Preset ----
            let selectedPresetSlot = 1;
            const presetRow = document.createElement('div');
            presetRow.style.cssText = `
                display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
                padding: 8px 10px; border-radius: 8px;
                background: linear-gradient(135deg, rgba(168,85,247,.08), rgba(168,85,247,.02));
                border: 1px solid rgba(168,85,247,.15);
            `;
            const presetBtnStyle = `border: 0; cursor: pointer; padding: 4px 10px; border-radius: 6px; font-size: 10px; font-weight: 600; transition: all .15s;`;
            const slotBtns = [];
            for (let slot = 1; slot <= 3; slot++) {
                const label = PRESET_NAMES[slot] || `预设${slot}`;
                const btn = document.createElement('button');
                btn.textContent = label;
                btn.title = `预设 ${slot}：${label}`;
                btn.style.cssText = presetBtnStyle + `background: rgba(168,85,247,.15); color: #a78bfa;`;
                btn.onmouseover = () => { if (selectedPresetSlot !== slot) btn.style.background = 'rgba(168,85,247,.25)'; };
                btn.onmouseout = () => { if (selectedPresetSlot !== slot) btn.style.background = 'rgba(168,85,247,.15)'; };
                btn.onclick = () => {
                    selectedPresetSlot = slot;
                    slotBtns.forEach((b, i) => {
                        const isSel = i + 1 === slot;
                        b.style.background = isSel ? 'rgba(168,85,247,.35)' : 'rgba(168,85,247,.15)';
                    });
                };
                if (slot === 1) btn.style.background = 'rgba(168,85,247,.35)';
                slotBtns.push(btn);
                presetRow.appendChild(btn);
            }
            const loadPresetBtn = document.createElement('button');
            loadPresetBtn.textContent = '加载';
            loadPresetBtn.title = '加载当前选中预设';
            loadPresetBtn.style.cssText = presetBtnStyle + `background: rgba(168,85,247,.2); color: #c4b5fd; margin-left: 4px;`;
            loadPresetBtn.onmouseover = () => { loadPresetBtn.style.background = 'rgba(168,85,247,.35)'; };
            loadPresetBtn.onmouseout = () => { loadPresetBtn.style.background = 'rgba(168,85,247,.2)'; };
            loadPresetBtn.onclick = () => {
                if (loadPreset(selectedPresetSlot)) {
                    const name = PRESET_NAMES[selectedPresetSlot] || `预设${selectedPresetSlot}`;
                    log(`✓ 已加载「${name}」，刷新页面生效`, 'success');
                    setTimeout(() => location.reload(), 800);
                } else {
                    log(`预设 ${selectedPresetSlot} 无数据`, 'warning');
                }
            };
            const savePresetBtn = document.createElement('button');
            savePresetBtn.textContent = '保存';
            savePresetBtn.title = '保存到当前选中预设';
            savePresetBtn.style.cssText = presetBtnStyle + `background: rgba(168,85,247,.15); color: #a78bfa;`;
            savePresetBtn.onmouseover = () => { savePresetBtn.style.background = 'rgba(168,85,247,.25)'; };
            savePresetBtn.onmouseout = () => { savePresetBtn.style.background = 'rgba(168,85,247,.15)'; };
            savePresetBtn.onclick = () => {
                if (savePreset(selectedPresetSlot)) {
                    const name = PRESET_NAMES[selectedPresetSlot] || `预设${selectedPresetSlot}`;
                    log(`✓ 已保存为「${name}」`, 'success');
                } else {
                    log('保存预设失败', 'error');
                }
            };
            presetRow.appendChild(loadPresetBtn);
            presetRow.appendChild(savePresetBtn);
            controlsWrap.appendChild(presetRow);

            // Controls: 交易额限制
            const volumeRow = document.createElement('div');
            volumeRow.style.cssText = `
                display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
                padding: 8px 10px; border-radius: 8px;
                background: linear-gradient(135deg, rgba(251,191,36,.08), rgba(251,191,36,.02));
                border: 1px solid rgba(251,191,36,.12);
            `;
            
            const volumeCheckbox = document.createElement('input');
            volumeCheckbox.type = 'checkbox';
            volumeCheckbox.checked = enableVolumeLimit;
            volumeCheckbox.style.cssText = `width: 12px; height: 12px; cursor: pointer; accent-color: #fbbf24; flex-shrink: 0;`;
            
            const volumeLabel = document.createElement('span');
            volumeLabel.textContent = '交易额达到';
            volumeLabel.style.cssText = `font-size: 10px; color: #fbbf24; font-weight: 600;`;
            
            const volumeInput = document.createElement('input');
            volumeInput.type = 'number';
            volumeInput.value = volumeLimitTarget;
            volumeInput.min = '1000';
            volumeInput.step = '1000';
            volumeInput.style.cssText = `
                width: 70px; border: 1px solid rgba(251,191,36,.2); border-radius: 4px;
                background: rgba(0,0,0,.25); color: #fbbf24; padding: 4px 6px;
                font-size: 11px; font-weight: 700; outline: none; text-align: center;
            `;
            volumeInput.disabled = !enableVolumeLimit;
            
            const volumeUnit = document.createElement('span');
            volumeUnit.textContent = 'USD 停止';
            volumeUnit.style.cssText = `font-size: 9px; color: #fbbf24; opacity: .7;`;
            
            const updateVolumeInputState = () => {
                volumeInput.disabled = !volumeCheckbox.checked;
                volumeInput.style.opacity = volumeCheckbox.checked ? '1' : '0.4';
            };
            
            volumeCheckbox.onchange = () => {
                enableVolumeLimit = volumeCheckbox.checked;
                updateVolumeInputState();
                if (enableVolumeLimit) {
                    log(`启用交易额限制: $${volumeLimitTarget.toLocaleString()}`, 'info');
                } else {
                    log('禁用交易额限制', 'info');
                }
                saveAllSettings();
            };
            
            volumeInput.onchange = () => {
                volumeLimitTarget = Math.max(1000, parseInt(volumeInput.value) || 100000);
                volumeInput.value = volumeLimitTarget;
                log(`交易额目标: $${volumeLimitTarget.toLocaleString()}`, 'info');
                saveAllSettings();
            };
            
            updateVolumeInputState();
            
            volumeRow.appendChild(volumeCheckbox);
            volumeRow.appendChild(volumeLabel);
            volumeRow.appendChild(volumeInput);
            volumeRow.appendChild(volumeUnit);
            
            controlsWrap.appendChild(volumeRow);

            // Controls: 滑点保护
            const slippageRow = document.createElement('div');
            slippageRow.style.cssText = `
                display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
                padding: 8px 10px; border-radius: 8px;
                background: linear-gradient(135deg, rgba(239,68,68,.08), rgba(239,68,68,.02));
                border: 1px solid rgba(239,68,68,.12);
            `;
            
            const slippageCheckbox = document.createElement('input');
            slippageCheckbox.type = 'checkbox';
            slippageCheckbox.checked = enableSlippageProtection;
            slippageCheckbox.style.cssText = `width: 12px; height: 12px; cursor: pointer; accent-color: #ef4444; flex-shrink: 0;`;
            
            const slippageLabel = document.createElement('span');
            slippageLabel.textContent = '滑点保护';
            slippageLabel.style.cssText = `font-size: 10px; color: #ef4444; font-weight: 600;`;
            
            const slippageInput = document.createElement('input');
            slippageInput.type = 'number';
            slippageInput.value = maxSlippagePercent;
            slippageInput.min = '0.01';
            slippageInput.max = '2';
            slippageInput.step = '0.01';
            slippageInput.style.cssText = `
                width: 70px; border: 1px solid rgba(239,68,68,.2); border-radius: 4px;
                background: rgba(0,0,0,.25); color: #ef4444; padding: 5px 8px;
                font-size: 12px; font-weight: 700; outline: none; text-align: center;
            `;
            slippageInput.disabled = !enableSlippageProtection;
            
            const slippageUnit = document.createElement('span');
            slippageUnit.textContent = '% 以内';
            slippageUnit.style.cssText = `font-size: 9px; color: #ef4444; opacity: .7;`;
            
            const slippageHint = document.createElement('span');
            slippageHint.textContent = '超过则刷新';
            slippageHint.style.cssText = `font-size: 8px; color: #ef4444; opacity: .5; margin-left: auto;`;
            
            const updateSlippageInputState = () => {
                slippageInput.disabled = !slippageCheckbox.checked;
                slippageInput.style.opacity = slippageCheckbox.checked ? '1' : '0.4';
            };
            
            slippageCheckbox.onchange = () => {
                enableSlippageProtection = slippageCheckbox.checked;
                updateSlippageInputState();
                if (enableSlippageProtection) {
                    log(`启用滑点保护: 最大 ${maxSlippagePercent}%`, 'info');
                } else {
                    log('禁用滑点保护', 'info');
                }
                saveAllSettings();
            };
            
            slippageInput.onchange = () => {
                maxSlippagePercent = Math.max(0.01, Math.min(2, parseFloat(slippageInput.value) || 0.05));
                slippageInput.value = maxSlippagePercent;
                log(`滑点阈值: ${maxSlippagePercent}% (万分之${Math.round(maxSlippagePercent * 100)})`, 'info');
                saveAllSettings();
            };
            
            updateSlippageInputState();
            
            slippageRow.appendChild(slippageCheckbox);
            slippageRow.appendChild(slippageLabel);
            slippageRow.appendChild(slippageInput);
            slippageRow.appendChild(slippageUnit);
            slippageRow.appendChild(slippageHint);
            
            controlsWrap.appendChild(slippageRow);

            // ---- UI: 新号一键部署（独立功能，与交易逻辑无关） ----
            const deployRow = document.createElement('div');
            deployRow.style.cssText = `
                display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
                padding: 8px 10px; border-radius: 8px;
                background: linear-gradient(135deg, rgba(34,197,94,.08), rgba(34,197,94,.02));
                border: 1px solid rgba(34,197,94,.2);
            `;
            const deployLabel = document.createElement('span');
            deployLabel.textContent = '新号一键部署';
            deployLabel.style.cssText = `font-size: 10px; font-weight: 600; color: #22c55e;`;
            const deployStartBtn = document.createElement('button');
            deployStartBtn.textContent = '开始';
            deployStartBtn.style.cssText = `
                border: 0; cursor: pointer; padding: 5px 12px; border-radius: 6px;
                font-size: 10px; font-weight: 600; background: #22c55e; color: #fff;
                transition: all .2s;
            `;
            deployStartBtn.onmouseover = () => { if (!isDeployRunning) deployStartBtn.style.background = '#16a34a'; };
            deployStartBtn.onmouseout = () => { if (!isDeployRunning) deployStartBtn.style.background = '#22c55e'; };
            const deployStopBtn = document.createElement('button');
            deployStopBtn.textContent = '停止';
            deployStopBtn.style.cssText = `
                border: 1px solid rgba(239,68,68,.5); cursor: pointer; padding: 5px 12px; border-radius: 6px;
                font-size: 10px; font-weight: 600; background: rgba(239,68,68,.15); color: #f87171;
                transition: all .2s;
            `;
            deployStopBtn.onmouseover = () => { deployStopBtn.style.background = 'rgba(239,68,68,.25)'; };
            deployStopBtn.onmouseout = () => { deployStopBtn.style.background = 'rgba(239,68,68,.15)'; };
            deployStartBtn.onclick = () => {
                if (isDeployRunning) return;
                isDeployRunning = true;
                deployStartBtn.disabled = true;
                deployStartBtn.style.opacity = '0.6';
                deployStopBtn.style.display = '';
                if (typeof UI.setDeployRunning === 'function') UI.setDeployRunning(true);
                runDeployLoop();
            };
            deployStopBtn.onclick = () => {
                stopDeployLoop();
                deployStartBtn.disabled = false;
                deployStartBtn.style.opacity = '1';
                deployStopBtn.style.display = 'none';
            };
            deployStopBtn.style.display = 'none';
            deployRow.appendChild(deployLabel);
            deployRow.appendChild(deployStartBtn);
            deployRow.appendChild(deployStopBtn);
            controlsWrap.appendChild(deployRow);

            this.setDeployRunning = (running) => {
                isDeployRunning = running;
                if (deployStartBtn) {
                    deployStartBtn.disabled = running;
                    deployStartBtn.style.opacity = running ? '0.6' : '1';
                }
                if (deployStopBtn) deployStopBtn.style.display = running ? '' : 'none';
            };

            // ---- UI: Log ----
            const logWrap = document.createElement('div');
            logWrap.style.cssText = `margin-top: 4px;`;
            
            // 日志头部（包含复制按钮）
            const logHeader = document.createElement('div');
            logHeader.style.cssText = `
                display: flex; justify-content: space-between; align-items: center;
                margin-bottom: 6px; padding: 0 2px;
            `;
            
            const logTitle = document.createElement('span');
            logTitle.textContent = '运行日志';
            logTitle.style.cssText = `font-size: 10px; font-weight: 600; color: #94a3b8;`;
            
            const copyBtn = document.createElement('button');
            copyBtn.textContent = '复制';
            copyBtn.style.cssText = `
                border: 0; cursor: pointer; color: #64748b;
                background: rgba(255,255,255,.06); padding: 3px 8px; border-radius: 4px;
                font-size: 9px; transition: all .2s;
            `;
            copyBtn.onmouseover = () => { copyBtn.style.background = 'rgba(255,255,255,.12)'; copyBtn.style.color = '#94a3b8'; };
            copyBtn.onmouseout = () => { copyBtn.style.background = 'rgba(255,255,255,.06)'; copyBtn.style.color = '#64748b'; };
            copyBtn.onclick = () => {
                const logText = this.logEl?.textContent || '';
                navigator.clipboard.writeText(logText).then(() => {
                    copyBtn.textContent = '✓ 已复制';
                    setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
                }).catch(() => {
                    // 回退方案
                    const textarea = document.createElement('textarea');
                    textarea.value = logText;
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                    copyBtn.textContent = '✓ 已复制';
                    setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
                });
            };
            
            logHeader.appendChild(logTitle);
            logHeader.appendChild(copyBtn);

            const logEl = document.createElement('pre');
            logEl.style.cssText = `
                margin: 0; padding: 8px 10px; border-radius: 8px;
                background: rgba(0,0,0,.4);
                border: 1px solid rgba(255,255,255,.08);
                font-size: 10px; line-height: 1.5;
                white-space: pre-wrap; word-break: break-word;
                max-height: 180px; min-height: 100px; overflow: auto;
                font-family: 'Consolas', 'Monaco', 'SF Mono', monospace;
                color: #f1f5f9;
            `;
            logEl.textContent = '准备就绪。点击 "开始交易" 开始。\n';

            logWrap.appendChild(logHeader);
            logWrap.appendChild(logEl);

            // ---- UI: Assemble ----
            body.appendChild(controlsWrap);
            body.appendChild(logWrap);

            root.appendChild(header);
            root.appendChild(body);
            document.body.appendChild(root);

            this.root = root;
            this.statusDot = dot;
            this.statusText = status;
            this.btnToggle = btn;
            this.logEl = logEl;
            this.body = body;
            this.collapseBtn = collapseBtn;

            // 绑定按钮事件
            btn.addEventListener('click', () => this.toggle());
            
            // 缩放按钮事件
            collapseBtn.addEventListener('click', () => this.toggleCollapse());
            
            // 应用初始缩放状态
            if (this.isCollapsed) {
                this.applyCollapseState(true);
            }

            // 使面板可拖拽
            this.makeDraggable(header, root);
            
            // 监听面板大小变化并保存
            const resizeObserver = new ResizeObserver(entries => {
                for (const entry of entries) {
                    const newWidth = Math.round(entry.contentRect.width);
                    if (newWidth >= this.panelMinWidth && newWidth <= this.panelMaxWidth) {
                        this.panelWidth = newWidth;
                        localStorage.setItem('tradeBotPanelWidth', String(newWidth));
                    }
                }
            });
            resizeObserver.observe(root);

            log('✓ 控制面板已加载', 'success');
        },

        makeDraggable(header, panel) {
            let isDragging = false, currentX, currentY, initialX, initialY;
            
            header.addEventListener('mousedown', (e) => {
                if (e.target.tagName === 'BUTTON') return;
                isDragging = true;
                initialX = e.clientX - panel.offsetLeft;
                initialY = e.clientY - panel.offsetTop;
            });
            
            document.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                e.preventDefault();
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
                panel.style.left = currentX + 'px';
                panel.style.top = currentY + 'px';
                panel.style.right = 'auto';
            });
            
            document.addEventListener('mouseup', () => { isDragging = false; });
        },

        setRunning(running) {
            if (!this.root) return;
            this.statusDot.style.background = running ? '#16a34a' : '#dc2626';
            this.statusText.textContent = running ? '运行中' : '已停止';
            this.btnToggle.textContent = running ? '停止交易' : '开始交易';
            this.btnToggle.style.background = running ? '#dc2626' : '#16a34a';
        },

        toggle() {
            if (isRunning) {
                stopSwapLoop();
            } else {
                executeSwapLoop();
            }
        },

        toggleCollapse() {
            this.isCollapsed = !this.isCollapsed;
            this.applyCollapseState(this.isCollapsed);
            localStorage.setItem('tradeBotPanelCollapsed', String(this.isCollapsed));
        },

        applyCollapseState(collapsed) {
            if (!this.body || !this.collapseBtn || !this.root) return;
            
            if (collapsed) {
                // 收起状态 - 强制重置高度
                this.body.style.display = 'none';
                this.collapseBtn.textContent = '▼';
                this.collapseBtn.title = '展开面板';
                this.root.style.minHeight = 'auto';
                this.root.style.maxHeight = 'none';
                this.root.style.height = 'auto';
                this.root.style.resize = 'none';
                this.root.style.overflow = 'visible';
            } else {
                // 展开状态
                this.body.style.display = 'flex';
                this.collapseBtn.textContent = '▲';
                this.collapseBtn.title = '收起面板';
                this.root.style.minHeight = '300px';
                this.root.style.maxHeight = '80vh';
                this.root.style.height = '';  // 清除固定高度，让内容决定
                this.root.style.resize = 'both';
                this.root.style.overflow = 'auto';
            }
        }
    };

    // ==================== 初始化 ====================
    function init() {
        // 等待页面加载完成
        const startUp = () => {
            UI.mount();
            
            // 检查是否需要自动重启（刷新页面后）；若用户曾点击停止则不再自动开始
            try {
                if (localStorage.getItem('tradegenius_user_stopped') === 'true') {
                    localStorage.removeItem('tradegenius_user_stopped');
                    localStorage.removeItem('tradegenius_autostart');
                    return;
                }
                const autostart = localStorage.getItem('tradegenius_autostart');
                if (autostart === 'true') {
                    localStorage.removeItem('tradegenius_autostart');
                    const savedSpeed = localStorage.getItem('tradegenius_speed');
                    if (savedSpeed) {
                        speedMultiplier = parseInt(savedSpeed) || 1;
                        log(`恢复速率设置: ${speedMultiplier}x`, 'info');
                    }
                    log('🔄 页面刷新后自动重启...', 'info');
                    setTimeout(() => {
                        if (!isRunning) executeSwapLoop();
                    }, CONFIG.RETRY_WAIT);
                }
            } catch (e) {}
        };
        
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(startUp, 1000);
            });
        } else {
            setTimeout(startUp, 1000);
        }
    }

    // 暴露全局函数（便于调试）
    window.startBot = () => {
        if (!isRunning) executeSwapLoop();
    };

    window.stopBot = () => {
        stopSwapLoop();
    };

    // 启动
    init();
    console.log('%c[Genius 现货自动交易] 脚本已加载', 'color: #10b981; font-weight: bold; font-size: 14px;');
})();
