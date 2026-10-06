 (() => {
    // ==========================================
    // CONFIGURATION
    // ==========================================
    const CONFIG = {
      // Set to false to disable continuous progress scoring and data piggybacking.
      // When false, the script will ONLY enforce the 100% score upon course completion.
      ENABLE_PROGRESS_SCORING: true, 
      
      // A unique identifier for appending hidden data to cmi.suspend_data
      PROXY_DELIMITER: "|||PROXY|||",
      
      // Toggle console logging for troubleshooting
      DEBUG_MODE: true, 

      // Set to false to use SCORM 1.2 api methods/fields
      USE_SCORM_2004: true, 
      
      // Maximum number of parent/opener windows to traverse when searching for the SCORM API
      MAX_API_ATTEMPTS: 30 
    };

    // ==========================================
    // UTILITY FUNCTIONS
    // ==========================================
    
    /**
     * Centralized logging wrapper to keep the console clean when disabled.
     */
    const logDebug = (message, data = "") => {
      if (CONFIG.DEBUG_MODE) {
        console.log(`[SCORM Proxy] ${message}`, data);
      }
    };

    /**
     * Locates the SCORM API wrapper in the DOM window hierarchy.
     * Traverses the parent chain first, then falls back to window.opener for popup launches.
     */
    const findScormAPI = (win) => {
      let attempts = 0;

      // Helper to scan a specific window chain (parent or opener)
      const scanChain = (currentWindow) => {
        while (currentWindow && attempts < CONFIG.MAX_API_ATTEMPTS) {
          attempts++;
          if (currentWindow.API_1484_11) return currentWindow.API_1484_11;
          if (currentWindow.API) return currentWindow.API;
          
          if (currentWindow.parent && currentWindow.parent !== currentWindow) {
            currentWindow = currentWindow.parent;
          } else {
            break; // Reached the top of this window chain
          }
        }
        return null;
      };

      // 1. Search the current window's parent chain
      logDebug("Scanning window parent chain for SCORM API...");
      let api = scanChain(win);

      // 2. Search the opener's parent chain (crucial for new-window launches)
      if (!api && win.opener && win.opener !== win) {
        logDebug("API not found in parent chain. Scanning window.opener chain...");
        api = scanChain(win.opener);
      }

      // Log the final discovery result
      if (api) {
        logDebug(`API successfully found after ${attempts} total attempts.`);
      } else {
        logDebug(`API NOT FOUND. Reached ${attempts} attempts limit or top of window chains.`);
      }

      return api;
    };

    // ==========================================
    // MAIN PROXY INITIALIZATION
    // ==========================================
    
    const initProxy = () => {
      const api = findScormAPI(window);
      if (!api) {
        logDebug("Initialization aborted: SCORM API could not be located.");
        return; 
      }

      // Determine API Version and Methods
      const isScorm2004 = CONFIG.USE_SCORM_2004;
      logDebug(`Initializing proxy for SCORM ${isScorm2004 ? "2004" : "1.2"}`);

      const setValueMethod = isScorm2004 ? "SetValue" : "LMSSetValue";
      const getValueMethod = isScorm2004 ? "GetValue" : "LMSGetValue";
      const commitMethod = isScorm2004 ? "Commit" : "LMSCommit";
      
      // Determine SCORM Data Fields based on version
      const fields = {
        location: isScorm2004 ? "cmi.location" : "cmi.core.lesson_location",
        scoreRaw: isScorm2004 ? "cmi.score.raw" : "cmi.core.score.raw",
        scoreMax: isScorm2004 ? "cmi.score.max" : "cmi.core.score.max",
        scoreScaled: "cmi.score.scaled", // 2004 only
        status: isScorm2004 ? "cmi.completion_status" : "cmi.core.lesson_status",
        suspendData: "cmi.suspend_data"
      };

      // Store Original Methods
      const originalSetValue = api[setValueMethod];
      const originalGetValue = api[getValueMethod];
      
      // State Variables
      const visitedLessons = new Set();
      let isCourseComplete = false;
      
      // Push Incremental Progress Score 
      const commitProgressScore = (score) => {
        logDebug(`Committing incremental progress score: ${score}`);
        originalSetValue.call(api, fields.scoreRaw, score.toString());
        
        if (isScorm2004) {
          const scaledScore = (score / 100).toFixed(2);
          originalSetValue.call(api, fields.scoreScaled, scaledScore.toString());
        }
        api[commitMethod].call(api, "");
      };

      // Push Final 100% Completion Score
      const commitCompletionScore = () => {
        logDebug("Course completion status detected. Forcing final 100% score.");
        originalSetValue.call(api, fields.scoreRaw, "100");
        originalSetValue.call(api, fields.scoreMax, "100");
        
        if (isScorm2004) {
          originalSetValue.call(api, fields.scoreScaled, "1.0");
        }
        api[commitMethod].call(api, "");
        isCourseComplete = true; // Lock the score so progress updates stop firing
      };

      // ==========================================
      // API INTERCEPTION (GET)
      // ==========================================
      api[getValueMethod] = function(key) {
        const value = originalGetValue.call(api, key);
        
        // Rehydrate data memory from previous sessions (if enabled)
        if (CONFIG.ENABLE_PROGRESS_SCORING && key === fields.suspendData && value && value.includes(CONFIG.PROXY_DELIMITER)) {
          logDebug("Intercepted suspend_data GET. Rehydrating visited lessons from previous session.");
          const parts = value.split(CONFIG.PROXY_DELIMITER);
          const savedLessons = parts[1];
          
          if (savedLessons) {
            savedLessons.split(",").forEach(lesson => {
              if (lesson) visitedLessons.add(lesson);
            });
            logDebug(`Restored ${visitedLessons.size} previously visited lessons.`);
          }
          // Return the clean, original suspend_data string to Rise
          return parts[0]; 
        }
        return value;
      };

      // ==========================================
      // API INTERCEPTION (SET)
      // ==========================================
      api[setValueMethod] = function(key, value) {
        
        // set score to 100% on completion (always active)
        if (key === fields.status && (value === "completed" || value === "passed")) {
          commitCompletionScore();
        }

        // Increment score by 1 for continuous progress scoring, since there 
        // is no way to reliably determine total lesson size in a Rise 
        // generated package. We will instead apply a schema in LMS to 
        // deliver Complete/Incomplete scoring. This will let us see 
        // who's started the training, and a general idea of how many 'lessons'
        if (CONFIG.ENABLE_PROGRESS_SCORING && !isCourseComplete) {
          
          // 1. Track location changes and push updated score
          if (key === fields.location && value) {
            const previousSize = visitedLessons.size;
            visitedLessons.add(value);
            
            // Only fire an update if a NEW lesson was visited
            if (visitedLessons.size > previousSize) {
              const currentScore = visitedLessons.size + 1;
              logDebug(`New lesson visited (${value}). Calculated progress score is now ${currentScore}.`);
              commitProgressScore(currentScore);
            }
          }

          // 2. Piggyback our visited lesson data onto suspend_data
          if (key === fields.suspendData) {
            const customDataString = Array.from(visitedLessons).join(",");
            value = value + CONFIG.PROXY_DELIMITER + customDataString;
          }
        }
        
        // Always pass the final structured key/value back to the real LMS API
        return originalSetValue.call(api, key, value);
      };
    };

    // Boot the proxy
    initProxy();
  })();
