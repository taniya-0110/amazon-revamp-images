const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { exec } = require('child_process'); // <-- 1. ADDED FOR FILE EXECUTION

const ChatGPTAutomation = require('./chatgptAutomation');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/', (req, res) => {
  res.send('Backend is running perfectly!');
});

// Serve generated and temporary listing images statically
app.use('/generated-images', express.static(path.join(__dirname, 'generated_images')));
app.use('/temp-images', express.static(path.join(__dirname, 'temp_images')));

// Ensure directories exist
const dirs = ['temp_images', 'generated_images', 'playwright-profile1'];
dirs.forEach(dir => {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
});

// ==========================================
// GLOBAL STATE - SHARED BETWEEN SERVER AND AUTOMATION
// ==========================================
let currentStatus = {
  status: 'idle',
  message: 'Ready',
  timestamp: new Date().toISOString(),
  data: {}
};

let currentResults = {
  analysis: null,
  generatedImages: [],
  totalImages: 0,
  currentImage: 0,
  rawResponse: null
};

let automationInstance = null;
let continueResolve = null;
let isRunning = false;

function clearDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath)) {
    fs.rmSync(path.join(dirPath, entry), { recursive: true, force: true });
  }
}

function writeEmptyResultsFile(type = 'reset') {
  fs.writeFileSync(path.join(__dirname, 'analysis_results.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    type,
    analysis: null,
    generatedImages: [],
    currentImage: 0,
    totalImages: 0,
    status: 'idle'
  }, null, 2));
}

function resetSessionState(type = 'reset', options = {}) {
  currentResults = {
    analysis: null,
    generatedImages: [],
    totalImages: 0,
    currentImage: 0,
    rawResponse: null
  };

  currentStatus = {
    status: 'idle',
    message: 'Ready for a new extension session.',
    timestamp: new Date().toISOString(),
    data: {}
  };

  if (options.clearImages) {
    clearDirectory(path.join(__dirname, 'temp_images'));
    clearDirectory(path.join(__dirname, 'generated_images'));
    
    // ✨ FIX: Safely attempt to wipe out the persistent profile folder during state resets
    try {
      const profilePath = path.join(__dirname, 'playwright-profile1');
      if (fs.existsSync(profilePath)) {
        fs.rmSync(profilePath, { recursive: true, force: true });
        fs.mkdirSync(profilePath, { recursive: true });
        console.log('[RESET] Persistent profile folder cleared successfully.');
      }
    } catch (profileClearError) {
      console.warn('[RESET] Profile folder currently busy; it will be cleared cleanly on the next browser boot.');
    }
  }

  try {
    writeEmptyResultsFile(type);
    fs.writeFileSync(path.join(__dirname, 'status.json'), JSON.stringify(currentStatus, null, 2));
    fs.writeFileSync(path.join(__dirname, 'continue_signal.json'), JSON.stringify({ status: 'reset' }, null, 2));
  } catch (error) {
    console.warn('[RESET] Could not reset persisted state:', error.message);
  }
}

function getImageExtension(source) {
  if (!source) return '.jpg';
  if (source.startsWith('data:image/png')) return '.png';
  if (source.startsWith('data:image/webp')) return '.webp';
  if (source.startsWith('data:image/gif')) return '.gif';
  if (source.startsWith('data:image/jpeg') || source.startsWith('data:image/jpg')) return '.jpg';
  try {
    const ext = path.extname(String(source).split('?')[0]).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext) ? ext : '.jpg';
  } catch (error) {
    return '.jpg';
  }
}

function saveFetchedImages(images) {
  const tempDir = path.join(__dirname, 'temp_images');
  clearDirectory(tempDir);

  return images.map((image, index) => {
    const sourceUrl = typeof image === 'string' ? image : image.url;
    const dataUrl = typeof image === 'string' ? '' : image.dataUrl;
    const ext = getImageExtension(dataUrl || sourceUrl);
    const filename = `listing_image_${String(index + 1).padStart(2, '0')}${ext}`;
    const filePath = path.join(tempDir, filename);
    const stored = typeof image === 'string' ? { url: image } : { ...image };

    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      return { ...stored, tempFile: '', tempUrl: '' };
    }

    const base64 = dataUrl.split(',')[1];
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));

    return {
      ...stored,
      tempFile: filePath,
      tempUrl: `/temp-images/${filename}`
    };
  });
}

// ==========================================
// STATUS & DISK PERSISTENCE MANAGEMENT
// ==========================================
function saveResultsToDisk() {
  try {
    const resultsFile = path.join(__dirname, 'analysis_results.json');
    fs.writeFileSync(resultsFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      analysis: currentResults.analysis,
      generatedImages: currentResults.generatedImages,
      currentImage: currentResults.currentImage,
      totalImages: currentResults.totalImages,
      rawResponse: currentResults.rawResponse,
      status: currentStatus.status
    }, null, 2));
    console.log('[DISK] Active results successfully synced to analysis_results.json');
  } catch (error) {
    console.error('[DISK] Error persisting results to disk:', error.message);
  }
}

function hydrateResultsFromDisk() {
  const resultsFile = path.join(__dirname, 'analysis_results.json');
  if (!fs.existsSync(resultsFile)) return;

  try {
    const saved = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    const savedAnalysis = saved.analysis || saved.results?.analysis || null;
    const savedGeneratedImages = saved.generatedImages || saved.results?.generatedImages || [];
    const savedCurrentImage = saved.currentImage || saved.results?.currentImage || 0;

    if (!currentResults.analysis && savedAnalysis) {
      currentResults.analysis = savedAnalysis;
      currentResults.rawResponse = saved.fullResponse || saved.rawResponse || saved.results?.rawResponse || currentResults.rawResponse;
    }

    // Only update generated images if we have new ones
    if (Array.isArray(savedGeneratedImages) && savedGeneratedImages.length > 0) {
      // Merge with existing images to avoid duplicates
      const existingNumbers = new Set(currentResults.generatedImages.map(img => img && img.imageNumber));
      for (const img of savedGeneratedImages) {
        const normalized = normalizeGeneratedImage(img);
        if (normalized && !existingNumbers.has(normalized.imageNumber)) {
          currentResults.generatedImages.push(normalized);
          existingNumbers.add(normalized.imageNumber);
        }
      }
      currentResults.currentImage = Math.max(currentResults.currentImage, getGeneratedCount());
    }

    if (!currentResults.totalImages) {
      currentResults.totalImages = currentResults.generatedImages.length || currentResults.analysis?.detailedAnalysis?.length || 0;
    }
  } catch (error) {
    console.warn('[RESULTS] Could not hydrate saved results:', error.message);
  }
}

function updateStatus(status, message, data = {}) {
  // FIXED: Allow fresh analysis to overwrite state instead of being locked out by old cached instances
  if (data.analysis) {
    currentResults.analysis = data.analysis;
  }

  // CRITICAL FIX: Always update generatedImages from data
  if (Array.isArray(data.generatedImages)) {
    // Merge with existing to avoid duplicates
    const existingNumbers = new Set(currentResults.generatedImages.map(img => img && img.imageNumber));
    for (const img of data.generatedImages) {
      const normalized = normalizeGeneratedImage(img);
      if (normalized && !existingNumbers.has(normalized.imageNumber)) {
        currentResults.generatedImages.push(normalized);
        existingNumbers.add(normalized.imageNumber);
      }
    }
    currentResults.currentImage = getGeneratedCount();
  }

  if (data.totalImages) {
    currentResults.totalImages = data.totalImages;
  }

  if (data.currentImage && status !== 'generating') {
    currentResults.currentImage = data.currentImage;
  }

  currentStatus = {
    status,
    message,
    timestamp: new Date().toISOString(),
    data: { ...currentStatus.data, ...data }
  };
  console.log(`[STATUS] ${status}: ${message}`);
  
  // Sync state modifications onto disk immediately so components polling get real-time info
  saveResultsToDisk();
}

function setAnalysisResults(analysis) {
  currentResults.analysis = analysis;
  console.log('[RESULTS] Analysis results stored');
  saveResultsToDisk();
}

function addGeneratedImage(imageData) {
  imageData = normalizeGeneratedImage(imageData);
  if (!imageData) return;

  // Check if this image number already exists
  const existingIndex = currentResults.generatedImages.findIndex(
    img => img.imageNumber === imageData.imageNumber
  );

  if (existingIndex >= 0) {
    currentResults.generatedImages[existingIndex] = imageData;
  } else {
    currentResults.generatedImages.push(imageData);
  }

  currentResults.currentImage = imageData.imageNumber;
  console.log(`[RESULTS] Generated image ${imageData.imageNumber} stored. Total: ${currentResults.generatedImages.length}`);
  saveResultsToDisk();
}

function normalizeGeneratedImage(imageData) {
  if (!imageData || typeof imageData !== 'object') return imageData;

  const normalized = { ...imageData };
  if (!normalized.imageUrl && normalized.url) {
    normalized.imageUrl = normalized.url;
  }

  if (!normalized.imageUrl && normalized.filePath) {
    normalized.imageUrl = `/generated-images/${path.basename(normalized.filePath)}`;
  }

  return normalized;
}

function getGeneratedCount() {
  // Only count images that have actual file paths or URLs
  return currentResults.generatedImages.filter(img => 
    img.filePath || img.imageUrl || img.url
  ).length;
}

// ==========================================================================
// ✨ GLOBAL SESSION CLEANUP UTILITY
// ==========================================================================
async function forceCleanupOldSession() {
  console.log("🧹 [CLEANUP] Request received. Cleaning up zombie browsers and resetting state...");
  
  // 1. Force resolve any stuck continue hooks so the Node event loop doesn't hang
  if (continueResolve) {
    try { continueResolve({ continue: false, abort: true }); } catch(e) {}
    continueResolve = null;
  }
  
  // 2. Kill the browser managed by your automation script
  if (automationInstance) {
    try {
      if (typeof automationInstance.cleanup === 'function') {
        await automationInstance.cleanup();
      } else if (typeof automationInstance.close === 'function') {
        await automationInstance.close();
      } else if (automationInstance.browser) {
        // Fallback if the browser reference is attached directly to the module export
        await automationInstance.browser.close();
        automationInstance.browser = null;
      }
      console.log("🧹 [CLEANUP] Stale browser closed successfully.");
    } catch (error) {
      console.warn("⚠️ [CLEANUP] Warning closing stale automation browser:", error.message);
    }
  }
  
  // 3. Reset running locks
  isRunning = false;
  automationInstance = null;
}


// ==========================================
// API ENDPOINTS
// ==========================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get current status
app.get('/api/status', (req, res) => {
  hydrateResultsFromDisk();

  res.json({
    ...currentStatus,
    generatedCount: getGeneratedCount(),
    totalImages: currentResults.totalImages,
    generatedImages: currentResults.generatedImages
  });
});

// Get analysis results
app.get('/api/analysis-results', (req, res) => {
  hydrateResultsFromDisk();
  currentResults.currentImage = getGeneratedCount();

  if (!currentResults.analysis) {
    return res.status(404).json({ 
      success: false, 
      error: 'No analysis results available yet' 
    });
  }

  res.json({
    success: true,
    analysis: currentResults.analysis,
    generatedImages: currentResults.generatedImages,
    totalImages: currentResults.totalImages,
    currentImage: currentResults.currentImage,
    rawResponse: currentResults.rawResponse
  });
});

// Get all results
app.get('/api/results', (req, res) => {
  hydrateResultsFromDisk();
  currentResults.currentImage = getGeneratedCount();

  res.json({
    success: true,
    results: currentResults,
    generatedCount: getGeneratedCount(),
    status: currentStatus.status
  });
});

// 🔄 MODIFIED: TRIGGER ENDPOINT NOW WIPES OUT PREVIOUS BROWSER & STALE FILES ON REFRESH
app.post('/api/run-trigger', async (req, res) => {
  // Clear any dangling browser from a previous extension window lifecycle
  await forceCleanupOldSession();

  // Reset all old data on extension load/reload so the plugin never displays stale output.
  resetSessionState('extension_startup', { clearImages: true });

  const scriptPath = process.env.MY_PLUGIN_SCRIPT;

  if (!scriptPath) {
    console.log('✅ [TRIGGER] Extension startup cleanup complete. No startup script configured.');
    return res.json({
      success: true,
      message: 'Backend is awake and previous session data was cleared.'
    });
  }

  console.log(`🚀 [TRIGGER] Extension initialized. Executing: ${scriptPath}`);

  exec(`"${scriptPath}"`, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ [TRIGGER] Runtime Execution Error: ${error.message}`);
      return;
    }
    
    if (stderr) {
      console.warn(`⚠️ [TRIGGER] Script output warning/stderr: ${stderr}`);
    }

    console.log('✅ [TRIGGER] Startup script completed:', stdout);
  });

  res.json({
    success: true,
    message: 'Backend is awake, previous session data was cleared, and startup script was launched.'
  });
});

// Store fetched Seller Central images in the temp folder immediately.
app.post('/api/store-images', (req, res) => {
  try {
    const { images } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No images provided'
      });
    }

    const storedImages = saveFetchedImages(images);
    clearDirectory(path.join(__dirname, 'generated_images'));

    currentResults = {
      analysis: null,
      generatedImages: [],
      totalImages: storedImages.length,
      currentImage: 0,
      rawResponse: null
    };

    fs.writeFileSync(path.join(__dirname, 'analysis_results.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'images_stored',
      analysis: null,
      generatedImages: [],
      currentImage: 0,
      totalImages: storedImages.length,
      status: 'images_stored'
    }, null, 2));

    currentStatus.data = {};
    updateStatus('images_stored', `${storedImages.length} listing images stored in temp folder.`, {
      totalImages: storedImages.length,
      tempImages: storedImages.map((img) => img.tempUrl).filter(Boolean)
    });

    res.json({
      success: true,
      images: storedImages,
      totalImages: storedImages.length
    });
  } catch (error) {
    console.error('[STORE] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate one image at a time after analysis is complete.
app.post('/api/continue', async (req, res) => {
  console.log('[CONTINUE] Received generate-next request from plugin');

  if (!automationInstance || !currentResults.analysis) {
    return res.status(400).json({
      success: false,
      error: 'Run analysis before generating images.'
    });
  }

  try {
    const result = await automationInstance.generateNextImageFromActiveChat();
    res.json({
      success: true,
      message: result.complete ? 'All images generated' : 'Image generated',
      result
    });
  } catch (error) {
    console.error('[CONTINUE] Error:', error);
    updateStatus('error', error.message, {
      analysis: currentResults.analysis,
      generatedImages: currentResults.generatedImages,
      totalImages: currentResults.totalImages,
      currentImage: currentResults.currentImage
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔄 MODIFIED: MAIN ANALYZE ENDPOINT NOW ENSURES DANGLING BROWSERS ARE CLEARED FIRST
app.post('/api/analyze-images', async (req, res) => {
  try {
    const { images } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No images provided' 
      });
    }

    // Clean up any old, stuck browser session before spinning up a new execution
    await forceCleanupOldSession();

    console.log(`[ANALYZE] Received ${images.length} images for analysis`);
    const storedImages = saveFetchedImages(images);
    clearDirectory(path.join(__dirname, 'generated_images'));

    // Reset state
    currentResults = {
      analysis: null,
      generatedImages: [],
      totalImages: storedImages.length,
      currentImage: 0,
      rawResponse: null
    };

    fs.writeFileSync(path.join(__dirname, 'analysis_results.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'analysis_started',
      analysis: null,
      generatedImages: [],
      currentImage: 0,
      totalImages: storedImages.length,
      status: 'starting'
    }, null, 2));

    isRunning = true;
    currentStatus.data = {};
    updateStatus('starting', 'Starting analysis...', { totalImages: storedImages.length });

    // Start automation in background
    res.json({ 
      success: true, 
      message: 'Analysis started',
      totalImages: storedImages.length
    });

    // Run automation
    try {
      const results = await runAutomation(storedImages);
      console.log('[AUTOMATION] Analysis completed successfully');
      updateStatus('analysis_complete', 'Analysis complete! Click Generate First Image when ready.', {
        totalImages: results.totalImages,
        generatedImages: results.generatedImages,
        analysis: results.analysis
      });
    } catch (err) {
      console.error('[AUTOMATION] Error:', err);
      updateStatus('error', err.message);
    } finally {
      isRunning = false;
    }

  } catch (error) {
    console.error('[ERROR] Analyze endpoint:', error);
    updateStatus('error', error.message);
    isRunning = false;
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// AUTOMATION RUNNER
// ==========================================
async function runAutomation(images) {
  // FIX 1: Correctly instantiate the class using the 'new' keyword
  automationInstance = new ChatGPTAutomation();

  // Inject server state callbacks into the newly created automation instance
  automationInstance._serverSetAnalysis = function(analysis, rawResponse) {
    if (rawResponse) currentResults.rawResponse = rawResponse;
    setAnalysisResults(analysis);
    updateStatus('analysis_complete', 'Analysis complete! Review results in plugin.', {
      analysis: analysis,
      totalImages: images.length
    });
  };

  automationInstance._serverAddGeneratedImage = function(imageData) {
    addGeneratedImage(imageData);
    updateStatus('image_generated', `Image ${imageData.imageNumber} generated successfully!`, {
      currentImage: getGeneratedCount(),
      totalImages: currentResults.totalImages,
      generatedImages: currentResults.generatedImages,
      analysis: currentResults.analysis
    });
  };

  automationInstance._serverUpdateStatus = function(status, message, data) {
    updateStatus(status, message, data);
  };

  automationInstance._serverWaitForContinue = async function() {
    return new Promise((resolve) => {
      continueResolve = resolve;

      // Also set up file-based watcher as backup
      const continueSignalFile = path.join(__dirname, 'continue_signal.json');
      fs.writeFileSync(continueSignalFile, JSON.stringify({ status: 'waiting' }));

      // Timeout after 30 minutes
      setTimeout(() => {
        if (continueResolve) {
          continueResolve({ continue: false, timeout: true });
          continueResolve = null;
        }
      }, 30 * 60 * 1000);
    });
  };

  // FIX 2: Removed the restrictive try/finally cleanup block.
  // We explicitly return the result here and let the browser stay open in the background 
  // so your continuation endpoint (/api/continue) can interact with it seamlessly.
  const results = await automationInstance.analyzeWithChatGPT(images);
  return results;
}

// ==========================================
// START SERVER (3. FIXED DUPLICATE LISTENERS)
// ==========================================
resetSessionState('server_startup', { clearImages: true });

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n=============================================================`);
  console.log(`🚀 Amazon Image Analyzer Backend running on Port: ${PORT}`);
  console.log(`🌍 Base URL: ${BACKEND_URL}`);
  console.log(`=============================================================`);
  console.log(`API Endpoints:`);
  console.log(`   GET  /api/health           - Health check`);
  console.log(`   GET  /api/status           - Current status`);
  console.log(`   GET  /api/analysis-results - Analysis results`);
  console.log(`   GET  /api/results          - All results`);
  console.log(`   POST /api/run-trigger      - Reset stale session data and optionally run startup script`);
  console.log(`   POST /api/store-images     - Store local workspace images`);
  console.log(`   POST /api/analyze-images   - Start analysis execution`);
  console.log(`   POST /api/continue         - Continue to next image`);
  console.log(`-------------------------------------------------------------`);
  console.log(`📁 Generated images served at: ${BACKEND_URL}/generated-images/`);
  console.log(`=============================================================\n`);
});
