const { chromium } = require('playwright');
// Add these lines at the absolute top of your file:
const path = require('path');
// This forces dotenv to load the file from the root directory relative to this script
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');

class ChatGPTAutomation {
  constructor() {
    this.chatgptUrl = process.env.CHATGPT_URL || 'https://chatgpt.com/';
    const appRoot = process.cwd(); // Resolves safely to where server.js runs
    this.tempImageFolder = path.join(appRoot, 'temp_images');
    this.generatedImagesFolder = path.join(appRoot, 'generated_images');
    this.profileFolder = path.join(appRoot, 'playwright-profile1');
    this.resultsFile = path.join(appRoot, 'analysis_results.json');
    this.statusFile = path.join(appRoot, 'status.json');
    this.continueSignalFile = path.join(appRoot, 'continue_signal.json');
    this.activePage = null;
    this.activeContext = null;
    this.activeAnalysis = null;
    this.activeGeneratedImages = [];
    this.activeTotalImages = 0;
    this.generationInProgress = false;
    this.sessionToken = process.env.CHATGPT_SESSION_TOKEN || "";
    // ? ADD THIS LINE RIGHT UNDER THEM:
    this.browser = null;

    // Safety checks to log out exactly what your app sees upon startup
    if (process.env.CHATGPT_SESSION_TOKEN_0) {
      console.log('?? Constructor Status: Multi-part chunks (0 and 1) verified inside .env');
    } else if (this.sessionToken) {
      console.log('?? Constructor Status: Single unified token layout detected inside .env');
    } else {
      console.log('?? Constructor Status: No local tokens or chunks matched in .env variables');
    }

    if (!fs.existsSync(this.tempImageFolder)) {
      fs.mkdirSync(this.tempImageFolder, { recursive: true });
    }
    
    if (!fs.existsSync(this.generatedImagesFolder)) {
      fs.mkdirSync(this.generatedImagesFolder, { recursive: true });
    }
    
    if (!fs.existsSync(this.profileFolder)) {
      fs.mkdirSync(this.profileFolder, { recursive: true });
    }
  }

  updateStatus(status, data = {}) {
    const statusData = {
      timestamp: new Date().toISOString(),
      status: status,
      data: data
    };
    fs.writeFileSync(this.statusFile, JSON.stringify(statusData, null, 2));
    console.log(`?? Status updated: ${status}`);

    if (typeof this._serverUpdateStatus === 'function') {
      this._serverUpdateStatus(status, data.message || status, data);
    }
  }

  async analyzeWithChatGPT(images) {
    let page = null;
    let context = null;
    let downloadedImages = [];
    let results = null;

    try {
      console.log(`?? Launching Chrome with persistent profile...`);
      console.log(`?? Processing ${images.length} images`);
      
      this.updateStatus('starting', { message: 'Launching Chrome...', totalImages: images.length });
      
      // ? FIX: Wipe old profile directory to release SingletonLocks and stale cache files before launch
      try {
        if (fs.existsSync(this.profileFolder)) {
          console.log('?? [AUTOMATION] Wiping profile folder to clear locks and ensure a pristine launch...');
          fs.rmSync(this.profileFolder, { recursive: true, force: true });
          fs.mkdirSync(this.profileFolder, { recursive: true });
        }
      } catch (profileErr) {
        console.warn('?? [AUTOMATION] Non-fatal warning clearing profile folder:', profileErr.message);
      }
      
      // 1. Launch a clean, non-persistent browser instance
      this.browser = await chromium.launch({
        headless: process.env.RENDER ? true : false,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          ...(process.env.RENDER 
            ? ['--no-sandbox', '--disable-setuid-sandbox'] 
            : [])
        ]
      });

      // Create an ephemeral, non-persistent context
      context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      });
      
      try {
        console.log('?? Clearing stale profile cookies to prevent session mixups...');
        await context.clearCookies();
      } catch (clearErr) {
        console.error('?? Could not wipe old profile cookies:', clearErr.message);
      }

      // 2. FETCH & INJECT LIVE SESSION COOKIES (Supports unified token or chunked formats)
      try {
        const liveCookies = await this.fetchLiveCookies();
        if (!liveCookies || liveCookies.length === 0) {
          throw new Error('ChatGPT session tokens are missing. Configure CHATGPT_SESSION_TOKEN, or both CHATGPT_SESSION_TOKEN_0 and CHATGPT_SESSION_TOKEN_1, in Render.');
        }
        if (liveCookies && liveCookies.length > 0) {
          console.log(`?? Injecting ${liveCookies.length} session cookies into context...`);
          await context.addCookies(liveCookies);
          const injectedNames = (await context.cookies('https://chatgpt.com')).map((cookie) => cookie.name);
          if (!injectedNames.some((name) => name.startsWith('__Secure-next-auth.session-token'))) {
            throw new Error('Render did not retain the ChatGPT session-token cookie. Check that the token values have no quotes or line breaks.');
          }
          console.log('? Session cookies successfully attached.');
        } else {
          console.log('?? No local session cookies found; proceeding with existing state.');
        }
      } catch (cookieError) {
        throw new Error(`Could not inject ChatGPT session cookies: ${cookieError.message}`);
        console.error('?? Problem injecting session cookies:', cookieError.message);
      }

      // 3. Open your page as normal
      page = context.pages()[0] || await context.newPage();
      this.activePage = page;
      this.activeContext = context;
      
      console.log('?? Navigating to ChatGPT...');
      this.updateStatus('navigating', { message: 'Opening ChatGPT...' });
      await page.goto(this.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Cookie-only authentication check. Never attempt a credential login.
      console.log('Checking ChatGPT session...');
      this.updateStatus('checking_login', { message: 'Checking login status...' });
      
      await page.waitForTimeout(3000);
      
      const textareaSelector = this.getComposerSelector();
      await this.ensureChatGPTReady(page, textareaSelector);
      console.log('ChatGPT session is ready.');

      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(__dirname, 'generated_images', 'render_debug.png'), fullPage: true });
      console.log("?? Debug screenshot saved to /generated-images/render_debug.png");
      // Start a new chat
      try {
        const newChatBtn = await page.locator('a:has-text("New Chat"), button:has-text("New Chat")').first();
        if (await newChatBtn.count() > 0 && await newChatBtn.isVisible({ timeout: 1000 })) {
          console.log('Starting a new chat...');
          await newChatBtn.click();
          await page.waitForTimeout(3000);
        }
      } catch (e) {
        console.log('Continuing with existing chat...');
      }

      // STEP 1: Download all images
      console.log(`?? Downloading all ${images.length} images...`);
      this.updateStatus('downloading', { message: 'Downloading images...', totalImages: images.length });
      
      downloadedImages = await this.downloadImages(images);
      
      if (downloadedImages.length === 0) {
        throw new Error('No listing images could be downloaded for ChatGPT analysis.');
      }

      console.log(`? Downloaded ${downloadedImages.length} images successfully`);

      // STEP 2: Upload images to ChatGPT
      console.log('?? Uploading images to ChatGPT...');
      this.updateStatus('uploading', { message: 'Uploading images to ChatGPT...' });
      
      await this.uploadImagesOptimized(page, downloadedImages);

      // PROMPT 1: AMAZON LISTING ANALYSIS
      console.log('?? Sending Prompt 1: Amazon Listing Analysis...');
      this.updateStatus('analyzing', { message: 'Analyzing images...' });
      
      const analysisPrompt = this.buildAnalysisPrompt(downloadedImages.length);
      
      await page.waitForTimeout(1000);
      
      // Ensure element focus before entering payload
      await this.ensureChatGPTReady(page, textareaSelector);
      const targetTextarea = page.locator(textareaSelector).first();
      await targetTextarea.click({ noWaitAfter: true });
      await page.waitForTimeout(200);

      const promptSent = await this.sendPromptWithEnter(page, analysisPrompt);
      
      if (!promptSent) {
        throw new Error('ChatGPT did not accept the analysis prompt.');
      }
      
      console.log('?? Analysis prompt sent!');

      console.log('? Waiting for analysis response...');
      console.log('? This may take 2-3 minutes for comprehensive analysis...');
      
      const analysisResponse = await this.waitForResponseWithContent(page, 300);
      
      if (!analysisResponse) {
        throw new Error('ChatGPT did not return an analysis response.');
      }

      console.log('? Analysis response received!');
      console.log('?? Parsing analysis results...');
      
      // Parse the analysis results
      const analysisResults = this.parseAnalysisResponse(analysisResponse, images);
      
      // Save analysis results immediately
      const analysisData = {
        timestamp: new Date().toISOString(),
        type: 'analysis',
        analysis: analysisResults,
        fullResponse: analysisResponse,
        generatedImages: [],
        status: 'analysis_complete'
      };
      
      fs.writeFileSync(this.resultsFile, JSON.stringify(analysisData, null, 2));
      console.log(`?? Analysis results saved to: ${this.resultsFile}`);
      
      this.updateStatus('analysis_complete', {
        message: 'Analysis complete! Review the results in the plugin.',
        analysis: analysisResults,
        totalImages: downloadedImages.length
      });

      if (typeof this._serverSetAnalysis === 'function') {
        this._serverSetAnalysis(analysisResults, analysisResponse);
      }

      const totalImages = downloadedImages.length;
      this.activeAnalysis = analysisResults;
      this.activeGeneratedImages = [];
      this.activeTotalImages = totalImages;
      this.generationInProgress = false;
      
      results = {
        analysis: analysisResults,
        generatedImages: [],
        status: 'analysis_complete',
        totalImages: totalImages
      };
      
      console.log(' ChatGPT remains open for review.');
      console.log(' Analysis results are available in the plugin sidebar.');
      console.log(' Image generation will start only when the plugin button is clicked.');
      
      return results;

    } catch (error) {
      console.error('? Error:', error.message);
      if (page) {
        await page.screenshot({ path: 'error-screenshot.png' });
        console.log('?? Saved error screenshot');
      }
      this.updateStatus('error', {
        message: error.message,
        error: error.message
      });
      if (context) await context.close().catch(() => {});
      this.activePage = null;
      this.activeContext = null;
      // Never present placeholder scores as a successful analysis.
      throw error;
    }
  }

  async pastePromptFast(page, chatBox, prompt) {
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

    try {
      await chatBox.click();
      await page.keyboard.down(modifier);
      await page.keyboard.press('a');
      await page.keyboard.up(modifier);
      await page.keyboard.press('Backspace');
      await page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
      }, prompt);
      await page.keyboard.down(modifier);
      await page.keyboard.press('v');
      await page.keyboard.up(modifier);
      await page.waitForTimeout(300);

      const pastedText = await chatBox.evaluate((element) => element.value || element.innerText || element.textContent || '');
      if (pastedText && pastedText.trim().length > 0) {
        console.log('Prompt pasted from clipboard');
        return true;
      }
    } catch (error) {
      console.log('Clipboard paste failed, trying direct DOM paste:', error.message);
    }

    try {
      await chatBox.evaluate((element, text) => {
        element.focus();
        element.innerHTML = '';
        const lines = text.split('\n');
        for (const line of lines) {
          const paragraph = document.createElement('p');
          paragraph.textContent = line || ' ';
          element.appendChild(paragraph);
        }
        element.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText',
          data: text,
          bubbles: true
        }));
      }, prompt);
      await page.waitForTimeout(300);

      const domText = await chatBox.evaluate((element) => element.value || element.innerText || element.textContent || '');
      if (domText && domText.trim().length > 0) {
        console.log('Prompt inserted directly');
        return true;
      }
    } catch (error) {
      console.log('Direct DOM paste failed, trying fill:', error.message);
    }

    try {
      await chatBox.fill(prompt);
      await page.waitForTimeout(300);
      const filledText = await chatBox.evaluate((element) => element.value || element.innerText || element.textContent || '');
      if (filledText && filledText.trim().length > 0) {
        console.log('Prompt filled directly');
        return true;
      }
    } catch (error) {
      console.log('Fill failed:', error.message);
    }

    return false;
  }

  async handleExpiredSessionModal(page, textareaSelector = '#prompt-textarea') {
    const modal = page.locator('#modal-expired-session, [data-testid="modal-expired-session"]').first();
    const modalVisible = await modal.count() > 0 && await modal.isVisible({ timeout: 1000 }).catch(() => false);

    if (!modalVisible) {
      return false;
    }

    throw new Error('ChatGPT session has expired. Replace the Render CHATGPT_SESSION_TOKEN value(s) and try again.');
  }

  getComposerSelector() {
    return [
      'textarea[data-testid="prompt-textarea"]',
      'textarea#prompt-textarea',
      '[data-testid="prompt-textarea"][contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]'
    ].join(', ');
  }

  async ensureChatGPTReady(page, textareaSelector = '#prompt-textarea') {
    await this.handleExpiredSessionModal(page, textareaSelector);

    const loginSelectors = [
      'button[data-testid="login-button"]',
      'a[href*="auth/login"]',
      'button:has-text("Log in")',
      'button:has-text("Sign up")'
    ].join(', ');
    const loginVisible = await page.locator(loginSelectors).first().isVisible({ timeout: 1500 }).catch(() => false);
    if (loginVisible || /auth\/login|auth0|sign-in/i.test(page.url())) {
      throw new Error('ChatGPT did not accept the configured session tokens. Refresh CHATGPT_SESSION_TOKEN (or _0 and _1) in Render; manual login is disabled.');
    }

    const blockingAlert = page.locator('span.fixed.inset-0.z-60 [role="alert"], [role="alert"].bg-red-500').first();
    if (await blockingAlert.count() > 0 && await blockingAlert.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('ChatGPT alert overlay detected. Waiting briefly for it to disappear...');
      await page.waitForTimeout(2500);
    }

    await this.handleExpiredSessionModal(page, textareaSelector);
    try {
      await page.waitForSelector(textareaSelector, { state: 'visible', timeout: 30000 });
    } catch (error) {
      throw new Error(`ChatGPT composer was not available after session-token authentication (${page.url()}). Refresh CHATGPT_SESSION_TOKEN (or _0 and _1) in Render; manual login is disabled.`);
    }
  }

  async sendPromptWithEnter(page, prompt) {
    try {
      console.log('?? Sending prompt with Enter key...');
      
      // 1. Give the UI breathing room to finish rendering the 9 images
      console.log('? Waiting 5 seconds for batch image uploads to stabilize...');
      await page.waitForTimeout(5000);

      // 2. Wait explicitly for visibility and increase the timeout to 60 seconds
      await this.ensureChatGPTReady(page, 'textarea[id="prompt-textarea"], #prompt-textarea, [contenteditable="true"]');

      const chatBox = await page.locator('textarea[id="prompt-textarea"], #prompt-textarea, [contenteditable="true"]').first();
      
      await chatBox.click({ noWaitAfter: true });
      await page.waitForTimeout(500);
      
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
      
      const pasted = await this.pastePromptFast(page, chatBox, prompt);
      if (!pasted) {
        console.log('Could not paste prompt automatically. Please paste it manually.');
        return false;
      }
      await page.waitForTimeout(500);
      
      console.log('?? Pressing Enter to send...');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      
      let messageSent = await this.checkIfMessageWasSent(page);
      
      if (messageSent) {
        console.log('? Message sent with Enter key!');
        return true;
      }
      
      console.log('?? Enter didn\'t work, trying Ctrl+Enter...');
      await chatBox.click({ noWaitAfter: true });
      await page.waitForTimeout(300);
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await page.waitForTimeout(1000);
      
      messageSent = await this.checkIfMessageWasSent(page);
      
      if (messageSent) {
        console.log('? Message sent with Ctrl+Enter!');
        return true;
      }
      
      console.log('?? Keyboard shortcuts failed, trying Send button...');
      
      const sendButtonSelectors = [
        'button[data-testid="send-button"]',
        'button[aria-label="Send message"]',
        'button:has-text("Send")',
        'button:has-text("?")',
        'button:has(svg[data-icon="arrow-right"])',
        '.composer-submit-button',
        'button:has(svg)'
      ];
      
      let sendButtonFound = false;
      for (const selector of sendButtonSelectors) {
        try {
          const btn = await page.locator(selector).first();
          if (await btn.count() > 0 && await btn.isVisible({ timeout: 1000 })) {
            await btn.click();
            console.log(`? Clicked Send button: ${selector}`);
            sendButtonFound = true;
            await page.waitForTimeout(1000);
            break;
          }
        } catch (e) {}
      }
      
      if (sendButtonFound) {
        messageSent = await this.checkIfMessageWasSent(page);
        if (messageSent) {
          console.log('? Message sent with Send button!');
          return true;
        }
      }
      
      console.log('?? Send button failed, trying double Enter...');
      await chatBox.click({ noWaitAfter: true });
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      
      messageSent = await this.checkIfMessageWasSent(page);
      
      if (messageSent) {
        console.log('? Message sent with double Enter!');
        return true;
      }
      
      console.log('? All send methods failed. Please send manually.');
      return false;
      
    } catch (error) {
      console.error('? Error sending prompt:', error.message);
      return false;
    }
  }

  async checkIfMessageWasSent(page) {
    try {
      const stopButton = await page.locator('button[aria-label*="Stop"]').first();
      if (await stopButton.count() > 0 && await stopButton.isVisible({ timeout: 1000 })) {
        console.log('  ? Response is generating (stop button visible)');
        return true;
      }
      
      const loadingIndicator = await page.locator('[data-testid*="loading"], .loading, .generating').first();
      if (await loadingIndicator.count() > 0 && await loadingIndicator.isVisible({ timeout: 1000 })) {
        console.log('  ? Response is generating (loading indicator visible)');
        return true;
      }
      
      const chatBox = await page.locator('#prompt-textarea').first();
      if (await chatBox.count() > 0) {
        const text = await chatBox.textContent();
        if (!text || text.trim().length === 0) {
          console.log('  ? Textarea is empty, message likely sent');
          return true;
        }
      }
      
      return false;
    } catch (error) {
      return false;
    }
  }

  async waitForResponseWithContent(page, timeoutSeconds = 300) {
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    let lastContentLength = 0;
    let stableCount = 0;

    console.log(`? Waiting up to ${timeoutSeconds} seconds for response...`);

    // Fix: Give ChatGPT a brief 3-second window to process the prompt and render the UI state
  await page.waitForTimeout(3000);

  while (Date.now() - startTime < timeoutMs) {
    try {
      const stopButtons = page.locator(
        "button[aria-label*='Stop'], button[data-testid*='stop'], button[aria-label='Stop generating']"
      );
      const isGenerating = await stopButtons.count() > 0;
      
      const assistantMessages = page.locator('[data-message-author-role="assistant"]');
      const msgCount = await assistantMessages.count();
      
      let currentText = '';
      if (msgCount > 0) {
        currentText = (await assistantMessages.last().textContent()) || '';
      }
      const currentLength = currentText.trim().length;

      if (isGenerating) {
        // ChatGPT is actively typing
        if (currentLength > lastContentLength) {
          lastContentLength = currentLength;
          stableCount = 0;
          console.log(`  ?? Response building... (${currentLength} characters)`);
        }
      } else {
        // No stop button visible. Verify if content is stable and valid.
        if (currentLength > 100 && currentLength === lastContentLength) {
          stableCount++;
          if (stableCount >= 3) { // Must remain unchanged for 3 consecutive checks (6 seconds)
            console.log(`  ? Response complete and stable (${currentLength} characters)`);
            return currentText;
          }
        } else if (currentLength > lastContentLength) {
          // Content is expanding even if the stop button briefly flickered away
          lastContentLength = currentLength;
          stableCount = 0;
        } else if (currentLength > 100 && stableCount === 0) {
          lastContentLength = currentLength;
          stableCount = 1;
        }
      }
    } catch (error) {
      console.log(`  ?? Error in response check loop: ${error.message}`);
    }

    await page.waitForTimeout(2000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    
    if (elapsed % 10 === 0 && elapsed > 0) {
      this.updateStatus('analyzing_progress', {
        message: `Analyzing images... ${elapsed}s elapsed`,
        progress: Math.min(elapsed / timeoutSeconds, 1)
      });
    }
  }

  console.log('?? Response wait timed out');
  try {
    const assistantMessages = page.locator('[data-message-author-role="assistant"]');
    if (await assistantMessages.count() > 0) {
      return (await assistantMessages.last().textContent()) || '';
    }
  } catch (e) {}
  
  return '';
}

  async uploadImagesOptimized(page, imagePaths) {
    try {
      console.log('  ?? Finding upload option...');
      
      let fileInput = await page.locator('input[type="file"]').first();
      let fileInputFound = await fileInput.count() > 0;
      
      if (fileInputFound) {
        console.log('  ? Found file input directly!');
        await this.uploadFilesFast(page, fileInput, imagePaths);
        return;
      }
      
      console.log('  ? Trying keyboard shortcut Ctrl+U...');
      try {
        await this.ensureChatGPTReady(page, '#prompt-textarea');
        const chatBox = await page.locator('#prompt-textarea').first();
        if (await chatBox.count() > 0) {
          await chatBox.click();
          await page.waitForTimeout(300);
        }
        
        await page.keyboard.down('Control');
        await page.keyboard.press('u');
        await page.keyboard.up('Control');
        await page.waitForTimeout(1000);
        
        fileInput = await page.locator('input[type="file"]').first();
        fileInputFound = await fileInput.count() > 0;
        
        if (fileInputFound) {
          console.log('  ? File input appeared after Ctrl+U!');
          await this.uploadFilesFast(page, fileInput, imagePaths);
          return;
        }
      } catch (e) {
        console.log('  ?? Ctrl+U shortcut failed:', e.message);
      }
      
      console.log('  ?? Looking for attach button...');
      try {
        const attachSelectors = [
          'button[data-testid="composer-attach"]',
          'button[aria-label="Attach files"]',
          'button:has(svg[data-icon="paperclip"])',
          'button:has(svg[data-icon="attachment"])',
          'button:has-text("??")',
          '.composer-attach-button',
          '[data-testid="composer-plus-btn"]',
          'button:has-text("+")'
        ];
        
        let attachFound = false;
        for (const selector of attachSelectors) {
          try {
            const btn = await page.locator(selector).first();
            if (await btn.count() > 0) {
              const isVisible = await btn.isVisible({ timeout: 1000 });
              if (isVisible) {
                console.log(`  ? Found attach button: ${selector}`);
                await btn.click();
                attachFound = true;
                await page.waitForTimeout(500);
                break;
              }
            }
          } catch (e) {}
        }
        
        if (attachFound) {
          const uploadSelectors = [
            'button:has-text("Upload from computer")',
            'button:has-text("Upload files")',
            'button:has-text("Add photos")',
            'button:has-text("Add files")',
            'button:has-text("Upload")',
            'span:has-text("Upload from computer")'
          ];
          
          for (const selector of uploadSelectors) {
            try {
              const btn = await page.locator(selector).first();
              if (await btn.count() > 0) {
                const isVisible = await btn.isVisible({ timeout: 1000 });
                if (isVisible) {
                  console.log(`  ? Found upload option: ${selector}`);
                  await btn.click();
                  await page.waitForTimeout(500);
                  break;
                }
              }
            } catch (e) {}
          }
          
          fileInput = await page.locator('input[type="file"]').first();
          fileInputFound = await fileInput.count() > 0;
          
          if (fileInputFound) {
            console.log('  ? File input found after attach!');
            await this.uploadFilesFast(page, fileInput, imagePaths);
            return;
          }
        }
      } catch (e) {
        console.log('  ?? Attach button method failed:', e.message);
      }
      
      console.log('  ?? Could not find file input automatically.');
      console.log('  ? Please upload images manually (20 seconds)...');
      
      try {
        await page.evaluate(() => {
          const msg = document.createElement('div');
          msg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:30px;border-radius:10px;box-shadow:0 0 30px rgba(0,0,0,0.3);z-index:9999;text-align:center;font-size:18px;';
          msg.innerHTML = '?? Please upload the images manually<br><span style="font-size:14px;color:#666;">Use the paperclip icon ? Upload from computer</span>';
          document.body.appendChild(msg);
          setTimeout(() => msg.remove(), 20000);
        });
      } catch (e) {}
      
      await page.waitForTimeout(20000);
      
      fileInput = await page.locator('input[type="file"]').first();
      fileInputFound = await fileInput.count() > 0;
      
      if (fileInputFound) {
        console.log('  ? File input found after manual upload!');
        await this.uploadFilesFast(page, fileInput, imagePaths);
      }
      
    } catch (error) {
      console.error('  ? Upload error:', error.message);
      console.log('  ? Please upload images manually (15 seconds)...');
      await page.waitForTimeout(15000);
    }
  }

  async uploadFilesFast(page, fileInput, imagePaths) {
    try {
      console.log(`  ?? Uploading ${imagePaths.length} images...`);
      
      try {
        await fileInput.setInputFiles(imagePaths);
        console.log(`  ? All ${imagePaths.length} images uploaded! (batch)`);
        await page.waitForTimeout(2000);
        return;
      } catch (error) {
        console.log('  ?? Batch upload failed, trying individual uploads...');
      }
      
      for (let i = 0; i < imagePaths.length; i++) {
        try {
          console.log(`  ?? Uploading image ${i + 1}/${imagePaths.length}...`);
          await fileInput.setInputFiles([imagePaths[i]]);
          await page.waitForTimeout(300);
          console.log(`  ? Image ${i + 1} uploaded`);
        } catch (e) {
          console.error(`  ? Failed to upload image ${i + 1}:`, e.message);
        }
      }
      
      console.log(`  ? Upload complete!`);
      await page.waitForTimeout(1000);
      
    } catch (error) {
      console.error('  ? Upload error:', error.message);
    }
  }

  async waitForContinuation(page) {
    fs.writeFileSync(this.continueSignalFile, JSON.stringify({ status: 'waiting' }));
    
    console.log('?? Waiting for "continue" signal from plugin...');
    
    let attempts = 0;
    const maxAttempts = 600;
    
    while (attempts < maxAttempts) {
      try {
        if (fs.existsSync(this.continueSignalFile)) {
          const signalData = JSON.parse(fs.readFileSync(this.continueSignalFile, 'utf8'));
          if (signalData.status === 'continue') {
            console.log('? Continue signal received!');
            fs.writeFileSync(this.continueSignalFile, JSON.stringify({ status: 'waiting' }));
            return true;
          }
        }
      } catch (e) {}
      
      await page.waitForTimeout(1000);
      attempts++;
      
      if (attempts % 30 === 0) {
        console.log(`? Still waiting for continuation signal... (${Math.floor(attempts/60)} minutes)`);
        this.updateStatus('waiting_continue', {
          message: `Waiting for "Generate Next" click... (${Math.floor(attempts/60)} minute${attempts >= 120 ? 's' : ''})`,
          waitTime: Math.floor(attempts/60)
        });
      }
    }
    
    console.log('? Timeout waiting for continuation signal.');
    this.updateStatus('timeout', {
      message: 'Timeout waiting for continuation signal.'
    });
    return false;
  }

  async generateNextImageFromActiveChat() {
    if (this.generationInProgress) {
      throw new Error('Image generation is already in progress.');
    }

    if (!this.activePage || !this.activeAnalysis) {
      throw new Error('Run analysis before generating images.');
    }

    const page = this.activePage;
    const totalImages = this.activeTotalImages || 0;
    const generatedImages = (this.activeGeneratedImages || []).filter((img) =>
      img && (img.filePath || img.imageUrl || img.url)
    );
    this.activeGeneratedImages = generatedImages;
    const imageNumber = generatedImages.length + 1;

    if (!totalImages || imageNumber > totalImages) {
      throw new Error('All images have already been generated.');
    }

    this.generationInProgress = true;

    try {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`?? GENERATING IMAGE ${imageNumber}/${totalImages}`);
      console.log(`${'='.repeat(50)}`);

      this.updateStatus('generating', {
        message: `Generating Image ${imageNumber}/${totalImages}...`,
        currentImage: imageNumber,
        totalImages: totalImages,
        analysis: this.activeAnalysis
      });

      const previousGeneratedSources = await this.getGeneratedImageSources(page);
      const generationPrompt = this.buildGenerationPrompt(imageNumber, totalImages);
      console.log(`?? Sending generation prompt for Image ${imageNumber}...`);

      const genPromptSent = await this.sendPromptWithEnter(page, generationPrompt);

      if (!genPromptSent) {
        throw new Error(`ChatGPT did not accept the generation prompt for Image ${imageNumber}.`);
      }

      console.log(`?? Generation prompt for Image ${imageNumber} sent!`);
      console.log(`? Waiting for Image ${imageNumber} to be generated...`);

      const imageResponse = await this.waitForResponseWithContent(page, 180);
      const savedGeneratedImage = await this.saveLastGeneratedImage(page, imageNumber, previousGeneratedSources);

      if (!imageResponse && !savedGeneratedImage) {
        this.updateStatus('error', {
          message: `Failed to generate Image ${imageNumber}`,
          currentImage: imageNumber,
          totalImages: totalImages,
          analysis: this.activeAnalysis
        });
        throw new Error(`Failed to generate Image ${imageNumber}`);
      }

      const imageData = {
        imageNumber: imageNumber,
        description: imageResponse || `Generated image ${imageNumber}`,
        imageUrl: savedGeneratedImage ? savedGeneratedImage.imageUrl || savedGeneratedImage.url : '',
        filePath: savedGeneratedImage ? savedGeneratedImage.filePath : '',
        timestamp: new Date().toISOString()
      };

      generatedImages.push(imageData);
      this.activeGeneratedImages = generatedImages;

      const genImagePath = path.join(this.generatedImagesFolder, `generated_image_${String(imageNumber).padStart(2, '0')}.json`);
      fs.writeFileSync(genImagePath, JSON.stringify(imageData, null, 2));

      const status = imageNumber >= totalImages ? 'completed' : 'waiting_continue';
      const resultsData = {
        timestamp: new Date().toISOString(),
        type: 'analysis_with_generation',
        analysis: this.activeAnalysis,
        generatedImages: generatedImages,
        currentImage: imageNumber,
        status: status
      };
      fs.writeFileSync(this.resultsFile, JSON.stringify(resultsData, null, 2));

      if (typeof this._serverAddGeneratedImage === 'function') {
        this._serverAddGeneratedImage(imageData);
      }

      this.updateStatus(status, {
        message: imageNumber >= totalImages
          ? `All ${totalImages} images generated successfully!`
          : `? Image ${imageNumber} generated! Click "Generate Next" to continue.`,
        currentImage: imageNumber,
        totalImages: totalImages,
        generatedImages: generatedImages,
        analysis: this.activeAnalysis
      });

      return {
        success: true,
        image: imageData,
        generatedImages,
        currentImage: imageNumber,
        totalImages,
        complete: imageNumber >= totalImages
      };
    } finally {
      this.generationInProgress = false;
    }
  }

  buildAnalysisPrompt(imageCount) {
    return `Act as a Senior Amazon Listing Image Optimization and CRO Expert.

Analyze each attached Amazon listing image individually.

For each image provide 2 points:
- Score (/10)
- Reasons for the deducted marks

Format your response EXACTLY as:

IMAGE 1
Score: X/10
Reasons for the deducted marks:
- [reason 1]
- [reason 2]

IMAGE 2
[Continue for all images]
`;
  }

  buildGenerationPrompt(imageNumber, totalImages) {
    return `You are a Senior Amazon Creative Director and Amazon Conversion Rate Optimization Specialist.
Using the analysis above, redesign ONLY Image ${imageNumber}.

IMPORTANT REQUIREMENTS:
Generate ONLY ONE image.
Create a single standalone Amazon listing image.
Maintain:
* Same product
* Same branding
* Same core product information
* Amazon compliance
Meet the following Amazon listing image standards:
* 1000x1000 pixels minimum
* 4K ultra-high resolution
* White background (compulsory only for main product image)
* No images of customer reviews, five-star imagery, claims (for example, free shipping) or selling partner-specific information
* No badges used on Amazon, or variations, modifications or anything confusingly similar to such badges. This includes, but is not limited to, Amazons Choice, Premium Choice, Amazon Alexa, Works with Amazon Alexa, Best seller or Top seller.
* Prohibited: Text, logos, graphics or watermarks over the top of a product or in the background
Do not change:
* Product name
* Product features
* Product description
* Product specifications
* Product front and back images
* Brand logo
* Brand name
* Book pages like table of contents, index, salient features or sample pages
Improve:
* Visual hierarchy
* Readability
* Mobile visibility
* Premium appearance
* Conversion rate optimization

Fix every weakness identified in the analysis.

The redesigned image must:
* Look like a Top 1% Amazon Best Seller listing image
* Be highly professional
* Be conversion-focused
* Be mobile-first
* Have premium commercial advertising quality
* Have clear typography
* Have strong product focus
* Have excellent feature communication
* Use modern Amazon design standards
* Be realistic and trustworthy
* Be 4K ultra-high resolution
Output only ONE improved image for Image ${imageNumber}.
Wait for the next instruction before generating Image ${imageNumber + 1}.`;
  }

  async saveResultsAndKeepOpen(results, page, context) {
    try {
      const resultsData = {
        timestamp: new Date().toISOString(),
        results: results,
        status: 'completed'
      };
      
      fs.writeFileSync(this.resultsFile, JSON.stringify(resultsData, null, 2));
      console.log(`?? Results saved to: ${this.resultsFile}`);
      
      console.log('?? ChatGPT remains open for you to review the results.');
      console.log('?? Results are also available in the plugin sidebar.');
      
    } catch (error) {
      console.error('? Error saving results:', error.message);
    }
  }

  async downloadImages(imageUrls) {
    const downloadedPaths = [];
    const totalImages = imageUrls.length;

    console.log(`Downloading ${totalImages} images...`);

    for (let i = 0; i < totalImages; i++) {
      try {
        const image = imageUrls[i];
        const sourceUrl = typeof image === 'string' ? image : image.url;
        const dataUrl = typeof image === 'string' ? '' : image.dataUrl;
        const tempFile = typeof image === 'string' ? '' : image.tempFile;
        const ext = this.getImageExtension(sourceUrl || dataUrl) || '.jpg';
        const filename = `image_${String(i + 1).padStart(2, '0')}${ext}`;
        const filepath = path.join(this.tempImageFolder, filename);

        console.log(`  Saving image ${i + 1}/${totalImages}`);

        if (tempFile && fs.existsSync(tempFile)) {
          downloadedPaths.push(tempFile);
          console.log(`  Using stored temp image ${i + 1}`);
          continue;
        }

        if (dataUrl && dataUrl.startsWith('data:image/')) {
          const base64 = dataUrl.split(',')[1];
          fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
          downloadedPaths.push(filepath);
          console.log(`  Saved image ${i + 1} from browser data`);
          continue;
        }

        const response = await axios({
          method: 'GET',
          url: sourceUrl,
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://sellercentral.amazon.in/'
          }
        });

        fs.writeFileSync(filepath, response.data);
        downloadedPaths.push(filepath);
        console.log(`  Downloaded image ${i + 1} (${(response.data.length / 1024).toFixed(1)} KB)`);

      } catch (error) {
        console.error(`  Failed to save image ${i + 1}:`, error.message);
      }
    }

    console.log(`Saved ${downloadedPaths.length}/${totalImages} images to: ${this.tempImageFolder}`);
    return downloadedPaths;
  }

  async getGeneratedImageCandidates(page) {
    return await page.evaluate(() => {
      const candidates = [];

      function addCandidate(img, meta = {}) {
        const rect = img.getBoundingClientRect();
        const src = img.currentSrc || img.src;
        const width = img.naturalWidth || rect.width || img.width || 0;
        const height = img.naturalHeight || rect.height || img.height || 0;
        const alt = img.alt || '';
        const haystack = `${src} ${alt} ${img.className || ''} ${img.id || ''}`.toLowerCase();

        if (!src || width < 256 || height < 256) return;
        if (haystack.includes('avatar') || haystack.includes('logo') || haystack.includes('icon')) return;
        if (haystack.includes('profile') || haystack.includes('spinner') || haystack.includes('loading')) return;

        candidates.push({
          src,
          width,
          height,
          alt,
          id: img.id || '',
          ...meta
        });
      }

      const assistantMessages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
      assistantMessages.forEach((message, messageIndex) => {
        Array.from(message.querySelectorAll('img')).forEach((img, imageIndex) => {
          addCandidate(img, {
            messageIndex,
            imageIndex,
            source: 'assistant_message'
          });
        });
      });

      if (candidates.length === 0) {
        Array.from(document.getElementsByTagName('img')).forEach((img, pageImageIndex) => {
          if (!img.id || !img.id.trim()) return;
          addCandidate(img, {
            pageImageIndex,
            source: 'id_filtered'
          });
        });
      }

      return candidates;
    });
  }

  async getGeneratedImageSources(page) {
    try {
      const candidates = await this.getGeneratedImageCandidates(page);
      return candidates.map((candidate) => candidate.src).filter(Boolean);
    } catch (error) {
      console.log('  ?? Could not snapshot existing generated images:', error.message);
      return [];
    }
  }

  async saveLastGeneratedImage(page, imageNumber, previousSources = []) {
    try {
      let candidate = null;
      const previousSourceSet = new Set(previousSources.filter(Boolean));

      // Wait for image to appear with retries
      for (let attempt = 0; attempt < 180; attempt++) {
        const candidates = await this.getGeneratedImageCandidates(page);
        const newCandidates = candidates.filter((item) => item.src && !previousSourceSet.has(item.src));
        candidate = newCandidates.length > 0 ? newCandidates[newCandidates.length - 1] : null;

        if (candidate) {
          console.log(`Found new generated image: ${candidate.src.substring(0, 50)}...`);
          break;
        }
        
        console.log(`Waiting for new image ${imageNumber} to appear... (attempt ${attempt + 1}/180)`);
        await page.waitForTimeout(1000);
      }

      if (!candidate) {
        console.log('No new generated image found');
        return null;
      }

      // Determine file extension
      const ext = this.getImageExtension(candidate.src) || '.png';
      const filename = `generated_image_${String(imageNumber).padStart(2, '0')}${ext}`;
      const filePath = path.join(this.generatedImagesFolder, filename);

      let buffer = null;

      try {
        // Try to fetch from browser first
        console.log(`  ?? Fetching image data for Image ${imageNumber}...`);
        
        const base64 = await page.evaluate(async ({ src, messageIndex, imageIndex, source }) => {
          let imageSrc = src;
          
          // If we have message and image indices, try to get from DOM
          if (source === 'assistant_message' && messageIndex !== undefined && imageIndex !== undefined) {
            const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
            const img = messages[messageIndex]?.querySelectorAll('img')?.[imageIndex];
            if (img) {
              imageSrc = img.currentSrc || img.src;
            }
          }
          
          if (!imageSrc) {
            throw new Error('No image source found');
          }
          
          const response = await fetch(imageSrc, { 
            credentials: 'include', 
            cache: 'no-store' 
          });
          
          if (!response.ok) {
            throw new Error(`Image fetch failed: ${response.status}`);
          }
          
          const blob = await response.blob();
          
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }, candidate);

        buffer = Buffer.from(base64, 'base64');
        console.log(`Image data fetched (${buffer.length} bytes)`);
        
      } catch (browserFetchError) {
        console.log('Browser image fetch failed, trying axios:', browserFetchError.message);
        
        try {
          const response = await axios.get(candidate.src, { 
            responseType: 'arraybuffer', 
            timeout: 60000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://chatgpt.com/'
            }
          });
          buffer = Buffer.from(response.data);
          console.log(`Image downloaded via axios (${buffer.length} bytes)`);
        } catch (axiosError) {
          console.error('Axios fetch failed:', axiosError.message);
          return null;
        }
      }

      if (!buffer || buffer.length < 1024) {
        console.log('Image buffer too small or empty');
        return null;
      }
      
      // Save to file
      fs.writeFileSync(filePath, buffer);
      console.log(`Image saved to: ${filePath}`);

      // Save image info to JSON file for reference
      const imageInfoPath = path.join(this.generatedImagesFolder, `generated_image_${String(imageNumber).padStart(2, '0')}.json`);
      const imageInfo = {
        imageNumber: imageNumber,
        filePath: filePath,
        imageUrl: '/generated-images/' + filename,
        url: '/generated-images/' + filename,
        width: candidate.width || 0,
        height: candidate.height || 0,
        alt: candidate.alt || '',
        id: candidate.id || '',
        timestamp: new Date().toISOString()
      };
      fs.writeFileSync(imageInfoPath, JSON.stringify(imageInfo, null, 2));
      console.log(`Image info saved to: ${imageInfoPath}`);

      return {
        filePath,
        imageUrl: '/generated-images/' + filename,
        url: '/generated-images/' + filename,
        width: candidate.width || 0,
        height: candidate.height || 0,
        id: candidate.id || ''
      };
      
    } catch (error) {
      console.error('Could not save generated image:', error.message);
      return null;
    }
  }

  getImageExtension(url) {
    if (!url) return '.jpg';
    if (url.startsWith('data:image/png')) return '.png';
    if (url.startsWith('data:image/webp')) return '.webp';
    if (url.startsWith('data:image/gif')) return '.gif';
    if (url.startsWith('data:image/jpeg') || url.startsWith('data:image/jpg')) return '.jpg';
    try {
      const cleanUrl = url.split('?')[0];
      const ext = path.extname(cleanUrl).toLowerCase();
      const validExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
      return validExts.includes(ext) ? ext : '.jpg';
    } catch (error) {
      return '.jpg';
    }
  }

  parseAnalysisResponse(response, originalImages) {
    return this.parseAnalysisResponseV2(response, originalImages);
  }

  parseAnalysisResponseV2(response, originalImages) {
    if (!response) return this.getFallbackAnalysis(originalImages);

    const results = {
      individualScores: [],
      overallScore: 'N/A',
      detailedAnalysis: [],
      rawResponse: response
    };

    try {
      const text = String(response).replace(/\r/g, '').replace(/\u00a0/g, ' ');
      const headers = [...text.matchAll(/^(?:#{1,6}\s*)?(?:\*\*)?\s*image\s*(\d+)\s*(?:\*\*)?\s*[:.-]?\s*$/gim)];

      for (let index = 0; index < headers.length; index++) {
        const header = headers[index];
        const nextHeader = headers[index + 1];
        const block = text.slice(header.index + header[0].length, nextHeader ? nextHeader.index : text.length);
        const score = block.match(/\bscore\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?/i);
        const reasonsSection = block.match(/(?:reasons?\s*(?:for\s*)?(?:the\s*)?(?:deducted\s*)?marks?|why\s*(?:marks?\s*)?were\s*deducted|deductions?)\s*[:=-]?\s*([\s\S]*?)(?=\n\s*(?:overall|total|final)\s+(?:listing\s+)?score\b|$)/i);
        const reasons = (reasonsSection ? reasonsSection[1] : '')
          .split(/\n+/)
          .map((line) => line.replace(/^\s*(?:[-*]+|\d+[.)])\s*/, '').replace(/^\s*(?:reason|deduction)\s*\d*\s*[:=-]\s*/i, '').replace(/\*\*/g, '').trim())
          .filter((line) => line && !/^(?:score|overall|total|final)\b/i.test(line));

        results.detailedAnalysis.push({
          imageNumber: Number(header[1]),
          score: score ? `${score[1]}/10` : 'N/A',
          reasonsForDeductedMarks: reasons
        });
      }

      const overall = text.match(/(?:overall|total|final)\s+(?:listing\s+)?score\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?/i);
      if (overall) results.overallScore = `${overall[1]}/10`;
      if (!results.detailedAnalysis.length) return this.parseAnalysisResponseAlternate(response, originalImages);

      results.detailedAnalysis.sort((a, b) => a.imageNumber - b.imageNumber);
      results.individualScores = results.detailedAnalysis.map((image) => ({
        image: image.imageNumber,
        score: image.score,
        reasonsForDeductedMarks: image.reasonsForDeductedMarks
      }));
      return results;
    } catch (error) {
      console.error('Error parsing response:', error);
      return this.parseAnalysisResponseAlternate(response, originalImages);
    }
  }

  parseAnalysisResponseLegacy(response, originalImages) {
  const results = {
    individualScores: [],
    overallScore: 'N/A',
    detailedAnalysis: [],
    rawResponse: response
  };

  // If ChatGPT returned nothing, bail out to fallback data safely
  if (!response) {
    return this.getFallbackAnalysis(originalImages);
  }

  try {
    console.log('Parsing ChatGPT response...');
    const lines = response.split('\n');
    let currentImage = null;
    let currentSection = null;
    let collectingReasons = false;
    let imageNumber = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      // 1. Match Image headers (e.g., "IMAGE 1:" or "Image 2")
      const imageMatch = line.match(/^IMAGE\s*[:]?\s*(\d+)/i) || 
                         line.match(/^Image\s*[:]?\s*(\d+)/i) || 
                         line.match(/^#?IMAGE\s*(\d+)/i);
      
      if (imageMatch) {
        // If we were already tracking an image, save it before starting the next one
        if (currentImage) {
          results.detailedAnalysis.push(currentImage);
        }
        imageNumber = parseInt(imageMatch[1]);
        currentImage = {
          imageNumber: imageNumber,
          score: 'N/A',
          reasonsForDeductedMarks: []
        };
        currentSection = 'image_header';
        collectingReasons = false;
        continue;
      }
      
      // 2. Match individual image scores
      const scoreMatch = line.match(/^Score\s*[:]?\s*([\d.]+)\s*\/\s*10/i) || 
                         line.match(/^Score\s*[:]?\s*([\d.]+)/i) || 
                         line.match(/Score\s*[:]?\s*([\d.]+)\s*\/\s*10/i);
      
      if (scoreMatch && currentImage && currentSection !== 'overall') {
        currentImage.score = scoreMatch[1] + '/10';
        currentSection = 'score';
        continue;
      }
      
      // 3. Match the global overall score line
      const overallMatch = line.match(/^Overall\s+Listing\s+Score\s*[:]?\s*([\d.]+)\s*\/\s*10/i) || 
                           line.match(/^Overall\s+Score\s*[:]?\s*([\d.]+)\s*\/\s*10/i) || 
                           line.match(/Overall\s+Score\s*[:]?\s*([\d.]+)/i);
      
      if (overallMatch) {
        results.overallScore = overallMatch[1] + '/10';
        currentSection = 'overall';
        continue;
      }
      
      // 4. Match the deductions header
      const reasonsMatch = line.match(/^Reasons for the deducted marks\s*[:]?/i) || 
                           line.match(/^Reasons for deducted marks\s*[:]?/i) || 
                           line.match(/^Reasons\s*[:]?/i) || 
                           line.match(/^Why marks were deducted\s*[:]?/i);
      
      if (reasonsMatch && currentImage) {
        currentSection = 'reasons';
        collectingReasons = true;
        continue;
      }
      
      // 5. Collect bullet points under the deductions section
      if (collectingReasons && currentImage && currentSection === 'reasons') {
        const bulletMatch = line.match(/^[-*]\s*(.+)/) || 
                            line.match(/^\d+[.)]\s*(.+)/) || 
                            line.match(/^-\s*(.+)/);
        
        if (bulletMatch) {
          currentImage.reasonsForDeductedMarks.push(bulletMatch[1].trim());
        } else if (!line.match(/^[A-Z]/)) { 
          // If line continues without a new bullet, append it to the previous bullet item
          if (currentImage.reasonsForDeductedMarks.length > 0) {
            const lastIdx = currentImage.reasonsForDeductedMarks.length - 1;
            currentImage.reasonsForDeductedMarks[lastIdx] += ' ' + line;
          } else {
            currentImage.reasonsForDeductedMarks.push(line);
          }
        }
      }
    }
    
    // ?? CRITICAL FIX: Save the last image block after the loop finishes exiting
    if (currentImage) {
      results.detailedAnalysis.push(currentImage);
    }
    
    return results;
  } catch (error) {
    console.error('Error parsing response:', error);
    return this.getFallbackAnalysis(originalImages);
  }
}

  parseAnalysisResponseAlternate(response, originalImages) {
    console.log('?? Using alternate parsing method...');
    
    const results = {
      individualScores: [],
      overallScore: 'N/A',
      detailedAnalysis: [],
      rawResponse: response
    };
    
    try {
      // Try to extract using regex for each image
      const imageCount = Math.min(originalImages.length, 9);
      
      for (let i = 1; i <= imageCount; i++) {
        const imageData = {
          imageNumber: i,
          score: 'N/A',
          reasonsForDeductedMarks: []
        };
        
        // Try to find score for this image
        const scoreRegex = new RegExp(`IMAGE\\s*${i}[\\s\\S]*?Score\\s*[:]?\\s*([\\d.]+)`, 'i');
        const scoreMatch = response.match(scoreRegex);
        if (scoreMatch) {
          imageData.score = scoreMatch[1] + '/10';
        }
        
        // Try to find reasons for this image
        // Look for reasons section after this image
        const reasonsRegex = new RegExp(
          `IMAGE\\s*${i}[\\s\\S]*?Reasons\\s*(?:for the deducted marks)?\\s*[:]?\\s*([\\s\\S]*?)(?=IMAGE|Overall|$)`,
          'i'
        );
        const reasonsMatch = response.match(reasonsRegex);
        
        if (reasonsMatch) {
          const reasonsText = reasonsMatch[1].trim();
          // Split by bullet points, new lines, or numbers
          const reasonLines = reasonsText
            .split(/[-*]\s*|\d+[.)]\s*|\n+/)
            .map(r => r.trim())
            .filter(r => r.length > 5 && !r.match(/^[A-Z][a-z]+:/));
          
          imageData.reasonsForDeductedMarks = reasonLines;
        }
        
        results.detailedAnalysis.push(imageData);
      }
      
      // Try to find overall score
      const overallRegex = /Overall\s+(?:Listing\s+)?Score\s*[:]?\s*([\d.]+)/i;
      const overallMatch = response.match(overallRegex);
      if (overallMatch) {
        results.overallScore = overallMatch[1] + '/10';
      }
      
      results.individualScores = results.detailedAnalysis.map(img => ({
        image: img.imageNumber,
        score: img.score
      }));
      
      console.log('Alternate parsing complete:', {
        images: results.detailedAnalysis.length,
        hasReasons: results.detailedAnalysis.some(img => img.reasonsForDeductedMarks.length > 0)
      });
      
      return results;
      
    } catch (error) {
      console.error('Alternate parsing failed:', error);
      return this.getFallbackAnalysis(originalImages);
    }
  }

  getFallbackAnalysis(images) {
    const imageCount = images.length;
    return {
      isFallback: true,
      individualScores: Array.from({ length: Math.min(imageCount, 9) }, (_, i) => ({
        image: i + 1,
        score: 'N/A'
      })),
      overallScore: 'N/A',
      detailedAnalysis: Array.from({ length: Math.min(images.length, 9) }, (_, i) => ({
        imageNumber: i + 1,
        score: 'N/A',
        reasonsForDeductedMarks: ['Waiting for ChatGPT analysis...']
      }))
    };
  }

  getFallbackResults(images) {
    const analysis = this.getFallbackAnalysis(images);
    return {
      analysis: analysis,
      generatedImages: [],
      status: 'fallback',
      totalImages: images.length,
      isFallback: true
    };
  }

  async cleanupTempImages(imagePaths) {
    console.log('?? Cleaning up temporary images...');
    for (const filepath of imagePaths) {
      try {
        if (fs.existsSync(filepath)) {
          fs.unlinkSync(filepath);
          console.log(`  ??? Deleted: ${path.basename(filepath)}`);
        }
      } catch (error) {}
    }
    console.log('Temporary images cleaned up');
  }

  // Change this to your RAW pastebin URL

  async fetchLiveCookies() {
    try {
      // Preferred form: the complete cookie array exported from an authenticated
      // chatgpt.com browser session. This preserves every cookie ChatGPT needs.
      const exportedCookies = process.env.CHATGPT_COOKIES;
      if (exportedCookies) {
        const parsed = JSON.parse(exportedCookies);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new Error('CHATGPT_COOKIES must be a non-empty JSON array.');
        }
        return parsed
          .filter((cookie) => cookie && cookie.name && cookie.value)
          .map((cookie) => {
            const normalized = { ...cookie };
            delete normalized.hostOnly;
            delete normalized.session;
            delete normalized.storeId;
            delete normalized.id;
            if (!normalized.url && !normalized.domain) normalized.url = 'https://chatgpt.com';
            if (normalized.expirationDate && !normalized.expires) {
              normalized.expires = Math.floor(normalized.expirationDate);
            }
            delete normalized.expirationDate;
            return normalized;
          });
      }

      const cookies = [];
      
      // 1. Check for chunked format (.0, .1) in environment variables
      const chunk0 = process.env.CHATGPT_SESSION_TOKEN_0;
      const chunk1 = process.env.CHATGPT_SESSION_TOKEN_1;

      if (chunk0) {
        if (!chunk1) {
          throw new Error('CHATGPT_SESSION_TOKEN_1 is missing. Configure both chunk variables, or configure the combined CHATGPT_SESSION_TOKEN.');
        }
        console.log('?? Detected chunked session tokens. Building multi-part cookie array...');
        
        cookies.push({
          name: '__Secure-next-auth.session-token',
          value: cleanToken,
          url: 'https://chatgpt.com',
          domain: '.chatgpt.com', // Explicitly share token authorization context across routes
          secure: true,
          httpOnly: true,
          sameSite: 'Lax'
        });
      } 
      // 2. Fallback to single token if it wasn't split yet
      else {
        const singleToken = this.sessionToken || process.env.CHATGPT_SESSION_TOKEN;
        
        if (!singleToken) {
          console.log('?? No session tokens or chunks found in environment variables.');
          return [];
        }

        const cleanToken = singleToken.replace(/["'\r\n]/g, '').trim();
        
        // If the single token happens to be massive (> 4000 chars), manually split it to be safe
        if (cleanToken.length > 4000) {
          console.log('Single token is extremely long. Auto-splitting into chunks to prevent rejection...');
          cookies.push({
            name: '__Secure-next-auth.session-token.0',
            value: cleanToken.substring(0, 4000),
            url: 'https://chatgpt.com',
            secure: true,
            httpOnly: true,
            sameSite: 'Lax'
          });
          cookies.push({
            name: '__Secure-next-auth.session-token.1',
            value: cleanToken.substring(4000),
            url: 'https://chatgpt.com',
            secure: true,
            httpOnly: true,
            sameSite: 'Lax'
          });
        } else {
          console.log('Injecting single-token configuration...');
          cookies.push({
            name: '__Secure-next-auth.session-token',
            value: cleanToken,
            url: 'https://chatgpt.com',
            secure: true,
            httpOnly: true,
            sameSite: 'Lax'
          });
        }
      }

      return cookies;
    } catch (error) {
      console.error('Failed to construct valid chunked session cookies:', error.message);
      return [];
    }
  }
  async cleanup() {
    console.log("🧹 [AUTOMATION] Running internal cleanup routine...");
    
    this.generationInProgress = false;

    if (this.activePage) {
      try { await this.activePage.close(); } catch (e) {}
      this.activePage = null;
    }

    if (this.activeContext) {
      try { await this.activeContext.close(); } catch (e) {}
      this.activeContext = null;
    }
    
    if (this.browser) {
      try { 
        await this.browser.close(); 
        console.log("🧹 [AUTOMATION] Standard browser terminated.");
      } catch (e) {}
      this.browser = null;
    }
    
    console.log("🧹 [AUTOMATION] Internal cleanup complete.");
  }
}

module.exports = ChatGPTAutomation;
