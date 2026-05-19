
// UNIFIED CONTENT.JS - Google Meet, Microsoft Teams & Zoom


// ============================================================
// GOOGLE CHAT HUDDLE RECORDER - Auto-save when leaving
// ============================================================

(function() {
    'use strict';

    const currentUrl = window.location.href;
    const isInIframe = window !== window.top;
    
    // Check if we're in the Huddle iframe
    const isHuddleIframe = currentUrl.includes('meet.google.com/_/frame') || 
                          (currentUrl.includes('meet.google.com') && isInIframe);
    
    // ============================================================
    // WE ARE IN THE HUDDLE IFRAME - RUN THE RECORDER DIRECTLY
    // ============================================================
    if (isHuddleIframe) {
        console.log("🎯 INSIDE HUDDLE IFRAME - Starting recorder directly");
        initDirectHuddleRecorder();
    }
    // ============================================================
    // WE ARE IN GOOGLE CHAT PARENT PAGE - MONITOR FOR IFRAME
    // ============================================================
    else if (currentUrl.includes('chat.google.com') || currentUrl.includes('mail.google.com')) {
        console.log("📧 Google Chat parent page - monitoring for huddle iframe");
        monitorForHuddleIframe();
    }

    // ============================================================
    // RELIABLE DOWNLOAD FUNCTION - Works with MV3 service workers
    // ============================================================
    async function downloadRecordingReliably(recordedChunks, customFilename = null) {
        if (!recordedChunks || recordedChunks.length === 0) {
            console.error("❌ No recorded chunks to download");
            return false;
        }
        
        const totalSize = recordedChunks.reduce((acc, chunk) => acc + chunk.size, 0);
        const fileSizeMB = (totalSize / 1024 / 1024).toFixed(2);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = customFilename || `huddle_recording_${timestamp}.webm`;
        
        console.log(`💾 Preparing download: ${filename} (${fileSizeMB} MB)`);
        
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        try {
            const response = await chrome.runtime.sendMessage({
                action: "downloadBlob",
                data: Array.from(uint8Array),
                mimeType: 'video/webm',
                filename: filename
            });
            
            if (response && response.success) {
                console.log(`✅ Download started via background: ${filename}`);
            } else {
                console.warn("Background download failed, using fallback");
                useAnchorDownload(blob, filename);
            }
        } catch (err) {
            console.warn("Could not send to background, using fallback:", err);
            useAnchorDownload(blob, filename);
        }
        
        try {
            chrome.runtime.sendMessage({ 
                action: "recordingCompleted", 
                filename: filename,
                size: fileSizeMB 
            });
        } catch(e) {}
        
        return true;
    }
    
    function useAnchorDownload(blob, filename) {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.style.position = 'fixed';
        a.style.top = '-100px';
        a.style.left = '-100px';
        document.body.appendChild(a);
        
        setTimeout(() => {
            a.click();
            setTimeout(() => {
                if (a.parentNode) document.body.removeChild(a);
                URL.revokeObjectURL(blobUrl);
            }, 1000);
        }, 100);
    }

    // ============================================================
    // DIRECT HUDDLE RECORDER - With Auto-Download on Leave
    // ============================================================
    function initDirectHuddleRecorder() {
        console.log("🔴 INITIALIZING DIRECT HUDDLE RECORDER");
        
        let mediaRecorder = null;
        let recordedChunks = [];
        let isRecording = false;
        let timerInterval = null;
        let statusDiv = null;
        let audioContext = null;
        let micGainNode = null;
        let muteCheckInterval = null;
        let screenStreamRef = null;
        let hasAutoSaved = false;
        
        function showStatus(msg, isError = false, duration = 0) {
            if (statusDiv && !document.body.contains(statusDiv)) {
                statusDiv = null;
            }
            
            if (!statusDiv) {
                statusDiv = document.createElement('div');
                statusDiv.id = 'huddle-recorder-status';
                statusDiv.style.cssText = `
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    background: #1a1a2e;
                    color: #fff;
                    padding: 12px 18px;
                    border-radius: 12px;
                    font-family: 'Google Sans', monospace;
                    font-size: 14px;
                    font-weight: bold;
                    z-index: 9999999 !important;
                    border-left: 4px solid ${isError ? '#ff4444' : '#4CAF50'};
                    box-shadow: 0 4px 15px rgba(0,0,0,0.4);
                    backdrop-filter: blur(8px);
                    pointer-events: none;
                    max-width: 350px;
                    white-space: pre-line;
                `;
                try {
                    document.body.appendChild(statusDiv);
                } catch(e) {
                    console.warn("Could not add status div:", e);
                    return;
                }
            }
            statusDiv.textContent = msg;
            statusDiv.style.borderLeftColor = isError ? '#ff4444' : '#4CAF50';
            
            if (duration > 0 && !msg.includes('RECORDING')) {
                setTimeout(() => {
                    if (statusDiv && statusDiv.parentNode && !isRecording) {
                        statusDiv.remove();
                        statusDiv = null;
                    }
                }, duration);
            }
        }
        
        async function forceSaveAndStop(reason) {
            if (!isRecording || hasAutoSaved) return false;
            
            console.log(`🛑 ${reason} - IMMEDIATELY saving recording to Downloads...`);
            hasAutoSaved = true;
            
            try {
                showStatus(`🎬 ${reason} - Saving recording to Downloads...`, false);
            } catch(e) {}
            
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
            
            if (muteCheckInterval) {
                clearInterval(muteCheckInterval);
                muteCheckInterval = null;
            }
            
            const chunksToSave = [...recordedChunks];
            
            if (chunksToSave.length > 0) {
                await downloadRecordingReliably(chunksToSave);
                console.log(`✅ Recording saved with ${chunksToSave.length} chunks`);
            } else {
                console.warn("⚠️ No chunks to save - recording may be empty");
                try {
                    showStatus("⚠️ No recording data to save", true, 3000);
                } catch(e) {}
            }
            
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                try {
                    mediaRecorder.onstop = null;
                    mediaRecorder.stop();
                } catch(e) {}
            }
            
            if (screenStreamRef) {
                try {
                    screenStreamRef.getTracks().forEach(t => t.stop());
                } catch(e) {}
                screenStreamRef = null;
            }
            
            if (audioContext) {
                try {
                    await audioContext.close();
                } catch(e) {}
                audioContext = null;
            }
            
            isRecording = false;
            
            try {
                chrome.runtime.sendMessage({ action: "recordingStopped" });
                chrome.storage.local.remove(['isRecording', 'recordingTime']);
            } catch(e) {}
            
            return true;
        }
        
        function stopRecording() {
            if (!isRecording) return false;
            return forceSaveAndStop("Recording stopped manually");
        }
        
        function startTimer() {
            let seconds = 0;
            if (timerInterval) clearInterval(timerInterval);
            
            timerInterval = setInterval(() => {
                if (!isRecording) return;
                seconds++;
                const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
                const secs = String(seconds % 60).padStart(2, '0');
                const timeStr = `${mins}:${secs}`;
                try {
                    showStatus(`🔴 RECORDING HUDDLE... ${timeStr}`);
                    chrome.storage.local.set({ recordingTime: timeStr });
                } catch(e) {}
            }, 1000);
        }
        
        function setupExtendButtonDetection() {
            console.log("🔍 Setting up Extend button detection");
            
            document.addEventListener('click', (e) => {
                const extendButton = e.target.closest(
                    'button[aria-label="Move to a tab"], ' +
                    'button[jsname="f0nqNc"], ' +
                    'button[data-tooltip*="Move to a tab"]'
                );

        if (extendButton && isRecording && !hasAutoSaved) {
            console.log("🚀 EXTEND BUTTON CLICKED - Moving to Meet tab");
            
            // Set flag to indicate we're extending (will force Meet recording)
            chrome.storage.local.set({ 
                isExtendingToMeet: true,
                extendTransitionTime: Date.now(),
                // forceMeetRecording: true  // NEW: Force Meet recording even if auto is OFF
            });
            
            e.preventDefault();
            e.stopPropagation();
            
            // ALWAYS save Huddle recording
            forceSaveAndStop("Extending to Meet - saving Huddle recording").then(() => {
                setTimeout(() => {
                    try {
                        extendButton.click();
                    } catch(err) {
                        console.log("Could not re-trigger extend click:", err);
                    }
                }, 500);
            });
        }
            }, true);
            
            const extendObserver = new MutationObserver(() => {
                const extendBtn = document.querySelector('button[aria-label="Move to a tab"], button[jsname="f0nqNc"]');
                if (extendBtn && !extendBtn.hasAttribute('data-extend-listener')) {
                    extendBtn.setAttribute('data-extend-listener', 'true');
                    console.log("✅ Extend button detected");
                }
            });
            
            extendObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
        }


        function setupLeaveButtonDetection() {
            console.log("🔍 Setting up Leave Call button detection");
            
            document.addEventListener('click', (e) => {
                if (!isRecording || hasAutoSaved) return;
                
                const leaveButton = e.target.closest(
                    'button[jsname="CQylAd"], ' +
                    '[aria-label="Leave call"], ' +
                    '[aria-label="Exit call"], ' +
                    'button[aria-label*="leave" i], ' +
                    '[data-tooltip="Leave call"], ' +
                    'button[jsname="CuS0Bf"]'
                );
                
                if (leaveButton) {
                    console.log("🚪 Leave call button clicked - will auto-save recording IMMEDIATELY");
                    e.preventDefault();
                    e.stopPropagation();
                    
                    forceSaveAndStop("Left the call").then(() => {
                        setTimeout(() => {
                            try {
                                leaveButton.click();
                            } catch(e) {
                                console.log("Could not re-trigger click");
                            }
                        }, 100);
                    });
                }
            }, true);
            
            const observer = new MutationObserver((mutations) => {
                if (!isRecording || hasAutoSaved) return;
                
                for (const mutation of mutations) {
                    if (mutation.removedNodes.length) {
                        for (const node of mutation.removedNodes) {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                const isLeaveButton = node.matches && (
                                    node.matches('button[jsname="CQylAd"]') ||
                                    node.matches('[aria-label="Leave call"]') ||
                                    node.matches('[aria-label="Exit call"]')
                                );
                                if (isLeaveButton) {
                                    console.log("🚪 Leave button removed from DOM - saving recording");
                                    forceSaveAndStop("Left the call");
                                }
                            }
                        }
                    }
                    
                    if (mutation.removedNodes.length) {
                        for (const node of mutation.removedNodes) {
                            if (node.nodeType === Node.ELEMENT_NODE && node.querySelectorAll) {
                                const videos = node.querySelectorAll('video');
                                if (videos.length > 0) {
                                    console.log("🎥 Video elements removed - call likely ended");
                                    forceSaveAndStop("Call ended");
                                }
                            }
                        }
                    }
                }
            });
            
            observer.observe(document.body, { 
                childList: true, 
                subtree: true,
                attributes: true,
                attributeFilter: ['disabled', 'class', 'aria-label']
            });
            
            window.__leaveDetectionCleanup = () => {
                observer.disconnect();
            };
        }
        
        function isInMeeting() {
            const selectors = [
                'button[jsname="CQylAd"]',
                '[aria-label="Leave call"]',
                '[aria-label="Exit call"]',
                'button[aria-label*="leave" i]',
                '[data-tooltip="Leave call"]',
                'video[autoplay]'
            ];
            
            for (const selector of selectors) {
                try {
                    const elements = document.querySelectorAll(selector);
                    for (const el of elements) {
                        if (el && el.offsetParent !== null) return true;
                    }
                } catch (e) {}
            }
            
            try {
                const videos = document.querySelectorAll('video');
                for (const video of videos) {
                    if (video.offsetParent !== null && video.videoWidth > 0) return true;
                }
            } catch(e) {}
            
            return false;
        }
        
        async function startRecording(isAuto = false) {
            if (isRecording) {
                showStatus('Already recording!', true, 2000);
                return false;
            }
            
            if (!isInMeeting()) {
                showStatus('❌ Not in a huddle! Join first', true, 3000);
                return false;
            }
            
            hasAutoSaved = false;
            showStatus('🎤 Opening picker - CHECK "Share audio"', false, 3000);
            
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { 
                        cursor: 'always', 
                        displaySurface: 'browser',
                        width: { ideal: 1920 },
                        height: { ideal: 1080 }
                    },
                    audio: { 
                        echoCancellation: false, 
                        noiseSuppression: false, 
                        sampleRate: 48000,
                        channelCount: 2
                    },
                    systemAudio: 'include',
                    preferCurrentTab: true
                });
                
                screenStreamRef = screenStream;
                
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const destination = audioContext.createMediaStreamDestination();
                
                const tabAudioTracks = screenStream.getAudioTracks();
                let finalStream = screenStream;
                
                if (tabAudioTracks.length > 0) {
                    const tabAudio = audioContext.createMediaStreamSource(
                        new MediaStream(tabAudioTracks)
                    );
                    tabAudio.connect(destination);
                    
                    try {
                        const micStream = await navigator.mediaDevices.getUserMedia({
                            audio: { 
                                echoCancellation: true, 
                                noiseSuppression: true,
                                sampleRate: 48000
                            },
                            video: false
                        });
                        
                        const micSource = audioContext.createMediaStreamSource(micStream);
                        micGainNode = audioContext.createGain();
                        micGainNode.gain.value = 0;
                        
                        micSource.connect(micGainNode);
                        micGainNode.connect(destination);
                        
                        finalStream = new MediaStream([
                            screenStream.getVideoTracks()[0],
                            ...destination.stream.getAudioTracks()
                        ]);
                        
                        muteCheckInterval = setInterval(() => {
                            if (!isRecording || !micGainNode) return;
                            const muteBtn = document.querySelector('button[aria-label*="microphone" i]');
                            if (muteBtn) {
                                const ariaLabel = muteBtn.getAttribute('aria-label') || '';
                                const isMuted = ariaLabel.includes('Turn on') || ariaLabel.includes('Unmute');
                                micGainNode.gain.value = isMuted ? 0 : 1.0;
                            } else {
                                micGainNode.gain.value = 1.0;
                            }
                        }, 300);
                        
                        console.log("✅ Microphone added with mute detection");
                        
                    } catch (micError) {
                        console.warn("Microphone not available:", micError);
                        showStatus("🎤 Meeting audio only (mic unavailable)", false, 3000);
                    }
                    
                    await audioContext.resume();
                } else {
                    showStatus("⚠️ No audio track - check 'Share audio'", true, 3000);
                }
                
                recordedChunks = [];
                
                const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') 
                    ? 'video/webm;codecs=vp9,opus' 
                    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
                        ? 'video/webm;codecs=vp8,opus'
                        : 'video/webm';
                
                mediaRecorder = new MediaRecorder(finalStream, {
                    mimeType: mimeType,
                    videoBitsPerSecond: 2500000,
                    audioBitsPerSecond: 256000
                });
                
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) {
                        recordedChunks.push(e.data);
                    }
                };
                
                mediaRecorder.onstop = () => {
                    if (!hasAutoSaved && recordedChunks.length > 0) {
                        downloadRecordingReliably(recordedChunks);
                    }
                    isRecording = false;
                };
                
                mediaRecorder.onerror = (e) => {
                    console.error("Recorder error:", e);
                    showStatus("Recording error occurred", true, 3000);
                };
                
                mediaRecorder.start(1000);
                isRecording = true;
                startTimer();
                setupExtendButtonDetection();
                setupLeaveButtonDetection();
                
                try {
                    await chrome.storage.local.set({ isRecording: true });
                    chrome.runtime.sendMessage({ action: "recordingStarted", isAuto: isAuto });
                } catch(e) {}
                
                console.log("✅ Recording started successfully - will auto-save when you leave the call");
                showStatus(`🔴 RECORDING HUDDLE... 00:00 - Will auto-save when you leave`);
                
                if (screenStream.getVideoTracks()[0]) {
                    screenStream.getVideoTracks()[0].onended = () => {
                        if (isRecording && !hasAutoSaved) {
                            forceSaveAndStop("Screen sharing stopped");
                        }
                    };
                }
                
                return true;
                
            } catch (error) {
                console.error("Start recording error:", error);
                showStatus(`❌ ${error.message}`, true, 4000);
                if (mediaRecorder && mediaRecorder.state === 'recording') {
                    try { mediaRecorder.stop(); } catch(e) {}
                }
                return false;
            }
        }
        
        async function loadAutoRecordSetting() {
            // For gchat, ALWAYS auto-record if in meeting
            // No need to check storage anymore
            if (isInMeeting()) {
                console.log("🎬 GChat: Auto-recording ALWAYS enabled - starting recording");
                setTimeout(() => startRecording(true), 1500);
            }
        }
        
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            console.log("📨 Huddle content script received:", message.action);
            
            switch (message.action) {
                case "startRecording":
                    startRecording(message.isAuto || false).then(success => {
                        sendResponse({ success: success });
                    });
                    return true;
                    
                case "stopRecording":
                    stopRecording();
                    sendResponse({ success: true });
                    break;
                    
                case "manualRecordingStarted":
                    startRecording(false).then(success => {
                        sendResponse({ success: success });
                    });
                    return true;
                    
                case "manualRecordingStopped":
                    stopRecording();
                    sendResponse({ success: true });
                    break;
                    
                case "getRecordingStatus":
                    sendResponse({ isRecording: isRecording });
                    break;
                    
                case "ping":
                    sendResponse({ success: true, alive: true });
                    break;
            }
            return true;
        });
        
        showStatus("📹 Huddle Recorder Ready\nRecording will auto-save to Downloads when you leave", false, 5000);
        
        setTimeout(() => {
            if (isInMeeting()) {
                loadAutoRecordSetting();
            }
        }, 1000);
        
        window.recordHuddle = () => startRecording(false);
        window.stopHuddle = () => stopRecording();
    }
    
    // ============================================================
    // MONITOR FOR HUDDLE IFRAME FROM PARENT PAGE
    // ============================================================
    function monitorForHuddleIframe() {
        console.log("👀 Monitoring for huddle iframe");
        
        let lastIframeStatus = false;
        
        function checkForIframe() {
            const iframes = document.querySelectorAll('iframe[src*="meet.google.com/_/frame"]');
            let iframeFound = false;
            
            for (const iframe of iframes) {
                const rect = iframe.getBoundingClientRect();
                const isVisible = iframe.offsetParent !== null && rect.width > 0;
                if (isVisible) {
                    iframeFound = true;
                    if (!iframe.dataset.recorderNotified) {
                        iframe.dataset.recorderNotified = "true";
                        console.log("🎯 Huddle iframe detected - recorder active inside");
                    }
                }
            }
            
            if (lastIframeStatus && !iframeFound) {
                console.log("📞 Huddle iframe disappeared - meeting likely ended");
            }
            
            lastIframeStatus = iframeFound;
        }
        
        const observer = new MutationObserver(() => checkForIframe());
        observer.observe(document.body, { childList: true, subtree: true });
        checkForIframe();
        setInterval(checkForIframe, 2000);
        
        setTimeout(() => {
            const hint = document.createElement('div');
            hint.textContent = "🎬 Huddle Recorder Ready! Recording auto-saves when you leave the call.";
            hint.style.cssText = `position:fixed;bottom:20px;right:20px;background:#1a73e8;color:#fff;padding:8px 14px;border-radius:20px;font-size:12px;z-index:100000;`;
            document.body.appendChild(hint);
            setTimeout(() => hint.remove(), 5000);
        }, 1000);
    }
})();


(function() {
    'use strict';

    // Service detection
    function detectService() {
        const url = window.location.href;
        // Check if we're in Huddle iframe FIRST
        if (url.includes('meet.google.com/_/frame') || (url.includes('meet.google.com') && window !== window.top)) {
            return null; // Don't run Meet code in Huddle iframe
        }
        if (url.includes('meet.google.com')) return 'gmeet';
        if (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) return 'teams';
        if (url.includes('zoom.us') || url.includes('zoom.com')) return 'zoom'; 
        return null;
    }

    const currentService = detectService();

    // Initialize based on service (only if NOT in Huddle iframe)
    if (currentService === 'gmeet') {
        gmeetContent();
    } else if (currentService === 'teams') {
        teamsContent();
    } else if (currentService === 'zoom') {
        zoomContent();
    }

    // ==================== GOOGLE MEET ====================
    function gmeetContent() {
        console.log("🔍 Initializing Google Meet content script");

        let isInMeeting = false;
        let recordingStarted = false;
        let autoRecordEnabled = false;
        let leaveButtonObserver = null;
        let lastLeaveButtonVisible = false;

        // Meeting Detection + Timer + Duration        
        let meetingStarted = false;
        let meetingStartTime = null;
        let meetingEndTime = null;
        let totalMeetingDuration = 0;

        function showMeetStatus(message, duration = 4000) {
            const existing = document.getElementById('meet-recorder-status');
            
            if (existing && message.includes("Recording...")) {
                existing.innerHTML = message.replace(/\n/g, '<br>');
                return;
            }
            
            if (existing) existing.remove();
            
            const status = document.createElement('div');
            status.id = 'meet-recorder-status';
            status.innerHTML = message.replace(/\n/g, '<br>');
            status.style.cssText = `
                position: fixed;
                bottom: 70px;
                right: 20px;
                background: rgba(0,0,0,0.95);
                color: white;
                padding: 12px 16px;
                border-radius: 10px;
                font-family: 'Google Sans', Arial, sans-serif;
                font-size: 14px;
                z-index: 100000;
                font-weight: bold;
                border: 2px solid #4285f4;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                backdrop-filter: blur(10px);
                max-width: 400px;
                word-wrap: break-word;
            `;
            
            document.body.appendChild(status);

            if (!message.includes("Recording...")) {
                setTimeout(() => {
                    const currentStatus = document.getElementById('meet-recorder-status');
                    if (currentStatus && !currentStatus.innerHTML.includes("Recording...")) {
                        currentStatus.remove();
                    }
                }, duration);
            }
        }

        function startMeetingTimer() {
            meetingStartTime = Date.now();
            const startTime = new Date(meetingStartTime).toLocaleTimeString();
            console.log(`%c📅 Meeting started at : ${startTime}`,"color: #0f9d58; font-weight: bold;");
            showMeetStatus(`📅 Meeting started at: ${startTime}`, 5000);
        }

        function stopMeetingTimer() {
            if (meetingStartTime) {
                meetingEndTime = Date.now();
                totalMeetingDuration = Math.floor((meetingEndTime - meetingStartTime) / 1000);
                
                const minutes = Math.floor(totalMeetingDuration / 60);
                const seconds = totalMeetingDuration % 60;
                const endTime = new Date(meetingEndTime).toLocaleTimeString();

                console.log(`%c📅 Meeting ended at : ${new Date(meetingEndTime).toLocaleTimeString()}`, "color: #d93025; font-weight: bold;");
                console.log(`%c⏱️ Duration of meeting : ${minutes}m ${seconds}s`, "color: #f4b400; font-weight: bold;");

                showMeetStatus(`📅 Meeting ended at : ${endTime}\n Duration: ${minutes}m ${seconds}s`, 5000);

                chrome.storage.local.set({
                    lastMeetingDuration: totalMeetingDuration,
                    lastMeetingEndTime: meetingEndTime
                });
                
                meetingStartTime = null;
                meetingEndTime = null;
            }
        }

        function getCurrentMeetingDuration() {
            if (meetingStartTime) {
                const currentDuration = Math.floor((Date.now() - meetingStartTime) / 1000);
                const minutes = Math.floor(currentDuration / 60);
                const seconds = currentDuration % 60;
                return `${minutes}m ${seconds}s`;
            }
            return "0m 0s";
        }

        function isMeetingActive() {
            return document.querySelector('[aria-label^="Leave call"], [aria-label^="Leave meeting"]');
        }

        async function initializeAutoRecord() {
            await checkAutoRecordPermission();
        
            // If auto-record is enabled, immediately check if we're in a meeting
            if (autoRecordEnabled) {
                console.log("🔄 Auto-record enabled - checking current meeting state");
                setTimeout(() => {
                    checkMeetingState();
                    // Force a re-check after a delay to catch any late-loading meetings
                    setTimeout(() => {
                        checkMeetingState();
                        // If we're in a meeting and auto-record is enabled, start recording
                        if (isInMeeting && autoRecordEnabled && !recordingStarted) {
                            console.log("🚀 Auto-record enabled and in meeting - starting recording");
                            startAutoRecording();
                        }
                    }, 3000);
                }, 1000);
            }
        }

        async function checkAutoRecordPermission() {
            return new Promise((resolve) => {
                chrome.storage.local.get(['autoRecordPermissions'], (result) => {
                    autoRecordEnabled = result.autoRecordPermissions?.['gmeet'] || false;
                    console.log(`🔐 Auto record enabled for gmeet:`, autoRecordEnabled);
                    resolve(autoRecordEnabled);
                });
            });
        }
        
        function startAutoRecordingImmediately() {
            if (isInMeeting && autoRecordEnabled) {
                console.log("🚀 Auto-record toggled ON mid-meeting - starting recording immediately");
                showMeetStatus("🟡 Auto recording starting now...");
                // Force reset recording state to ensure fresh start
                recordingStarted = false;
        
                // Clear any existing recording timeouts
                if (window.autoRecordTimeout) {
                    clearTimeout(window.autoRecordTimeout);
                    window.autoRecordTimeout = null;
                }
                startAutoRecording();
            }
        }

        function findLeaveButton() {
            const selectors = [
                'button[aria-label="Leave call"]',
                'button[aria-label*="Leave call"]',
                'div[role="button"][data-tooltip="Leave call"]',
                'div[role="button"][aria-label*="Leave"]',
                'button[jscontroller][jsname][aria-label*="Leave"]',
            ];
            for (const selector of selectors) {
                const el = document.querySelector(selector);
                if (el) return el;
            }
            return null;
        }

        function isElementVisible(element) {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' &&
                   style.visibility !== 'hidden' &&
                   style.opacity !== '0' &&
                   rect.width > 0 &&
                   rect.height > 0 &&
                   element.offsetParent !== null;
        }        

        function checkMeetingState() {

            const leaveButton = findLeaveButton();
            const leaveVisible = leaveButton && isElementVisible(leaveButton);

            if (leaveVisible && !lastLeaveButtonVisible) {
                console.log("✅ Leave button visible - Meeting joined");
                isInMeeting = true;
                meetingStarted = true;
                startMeetingTimer();

                const startTime = new Date(meetingStartTime).toLocaleTimeString();
                
                if (autoRecordEnabled && !recordingStarted) {
                    console.log("🔄 Auto-record enabled - starting recording in 3 seconds...");
                    showMeetStatus(`📅 Meeting started at: ${startTime}\n🟡 Auto recording starting in 3 seconds...`);

                    // Clear any existing timeout
                    if (window.autoRecordTimeout) {
                        clearTimeout(window.autoRecordTimeout);
                    }
                    
                    window.autoRecordTimeout = setTimeout(async () => {
                        if (isInMeeting && autoRecordEnabled && !recordingStarted) {
                            await startAutoRecording();
                        }
                    }, 3000);
                } else {
                    showMeetStatus(`📅 Meeting started at: ${startTime}`, 5000);
                }
            }

            if (!leaveVisible && lastLeaveButtonVisible) {
                console.log("❌ Leave button hidden - Meeting ended");
                isInMeeting = false;
                meetingStarted = false;
                stopMeetingTimer();
                
                // Clear auto-record timeout if meeting ended
                if (window.autoRecordTimeout) {
                    clearTimeout(window.autoRecordTimeout);
                    window.autoRecordTimeout = null;
                }
        
                if (recordingStarted) {
                    console.log("🛑 Meeting ended - stopping recording");
                    chrome.runtime.sendMessage({ action: "stopRecordingOnMeetingEnd" });
                }
            }

            lastLeaveButtonVisible = leaveVisible;
            chrome.storage.local.set({ isInMeeting });
        }

        function forceMeetingRedetection() {
            console.log("🔍 Force re-detecting meeting state...");
            const leaveButton = findLeaveButton();
            const leaveVisible = leaveButton && isElementVisible(leaveButton);
            
            if (leaveVisible && !isInMeeting) {
                console.log("✅ Force detected: In meeting");
                isInMeeting = true;
                meetingStarted = true;
                if (!meetingStartTime) {
                    startMeetingTimer();
                }
                return true;
            } else if (!leaveVisible && isInMeeting) {
                console.log("✅ Force detected: Not in meeting");
                isInMeeting = false;
                meetingStarted = false;
                return false;
            }
            return isInMeeting;
        }

        function aggressiveInitialCheck() {
            setTimeout(() => {
                console.log("🔍 Aggressive initial meeting check...");
                checkMeetingState();
                setTimeout(() => {
                    if (!isInMeeting) {
                        checkMeetingState();
                    }
                }, 2000);
            }, 1000);
        }

        async function startAutoRecording() {
            if (recordingStarted) {
                console.log("⚠️ Auto recording already started, skipping");
                return;
            }
            
            console.log("🚀 Starting auto recording...");

            chrome.storage.local.set({ isRecording: false });

            
            try {
                const response = await new Promise((resolve) => {
                    chrome.runtime.sendMessage({ action: "autoStartRecording" }, resolve);
                });
                
                if (response?.success) {
                    recordingStarted = true;            
                    chrome.storage.local.set({ isRecording: true });

                } else {
                    console.log("❌ Failed to start auto recording:", response);
                    recordingStarted = false;
                    showMeetStatus("❌ Auto Recording Failed");
                    // Retry after 3 seconds if failed
                    setTimeout(() => {
                        if (isInMeeting && autoRecordEnabled && !recordingStarted) {
                            console.log("🔄 Retrying auto recording...");
                            startAutoRecording();
                        }
                    }, 3000);
                }
            } catch (error) {
                console.log("❌ Error starting auto recording:", error);
                recordingStarted = false;
                showMeetStatus("❌ Auto Recording Error");
            }
        }

        async function initializeWithStateRecovery() {
            await checkAutoRecordPermission();
            setupLeaveButtonObserver();
            
            const storageState = await new Promise(resolve => {
                chrome.storage.local.get(['isRecording', 'isInMeeting'], resolve);
            });
            
            console.log("🔄 State recovery check:", storageState);
            
            if (storageState.isInMeeting && !isInMeeting) {
                console.log("🔄 Recovering meeting state from storage");
                forceMeetingRedetection();
            }
            
            if (storageState.isRecording && !recordingStarted) {
                console.log("🔄 Resetting inconsistent recording state");
                chrome.storage.local.set({ isRecording: false });
            }
            
            checkInitialMeetingState();
            setInterval(checkMeetingState, 2000);
            aggressiveInitialCheck();
        }

        function stopAutoRecording() {
            if (!recordingStarted) return;
            recordingStarted = false;

            chrome.runtime.sendMessage({ action: "autoStopRecording" }, (response) => {
                if (response?.success) {
                    console.log("✅ Auto recording stopped");
                    if (autoRecordEnabled) {
                        chrome.runtime.sendMessage({ action: "closeRecorderTab" });
                    }
                } else {
                    console.log("❌ Failed to stop auto recording");
                }
            });
        }

        function setupLeaveButtonObserver() {
            if (leaveButtonObserver) leaveButtonObserver.disconnect();
            leaveButtonObserver = new MutationObserver(() => {
                setTimeout(checkMeetingState, 500);
            });
            leaveButtonObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class', 'aria-hidden', 'disabled']
            });
        }

        function checkInitialMeetingState() {
            const leaveButton = findLeaveButton();
            const leaveVisible = leaveButton && isElementVisible(leaveButton);
            
            if (leaveVisible && !isInMeeting) {
                console.log("🔍 Already in meeting - will auto-start recording in 3 seconds");
                isInMeeting = true;
                meetingStarted = true;
                
                if (!meetingStartTime) {
                    startMeetingTimer();
                }
                
                if (autoRecordEnabled && !recordingStarted) {
                    console.log("🚀 Auto-starting recording for existing meeting");
                    showMeetStatus("🟡 Auto recording starting in 3 seconds...", 3000);
                    setTimeout(async () => {
                        await startAutoRecording();
                    }, 3000);
                }
            }
        }

        function getMuteStatus() {
            const muteButton = document.querySelector('[aria-label*="microphone"]') || 
                             document.querySelector('[data-tooltip*="microphone"]') ||
                             document.querySelector('[jscontroller*="microphone"]');
            
            if (muteButton) {
                const ariaLabel = muteButton.getAttribute('aria-label') || '';
                const isMuted = ariaLabel.includes('unmute') || ariaLabel.includes('Turn on');
                return { isMuted: isMuted };
            }
            
            const muteIcon = document.querySelector('svg[aria-label*="microphone"]');
            if (muteIcon) {
                const ariaLabel = muteIcon.getAttribute('aria-label') || '';
                const isMuted = ariaLabel.includes('unmute') || ariaLabel.includes('Turn on');
                return { isMuted: isMuted };
            }
            
            return { isMuted: true };
        }

        function forceResetAndRetry() {
            console.log("🔄 FORCE RESET - Resetting everything...");
            recordingStarted = false;
            forceMeetingRedetection();
            
            const existingStatus = document.getElementById('meet-recorder-status');
            if (existingStatus) existingStatus.remove();
            
            chrome.storage.local.set({ 
                isRecording: false,
                recordingStoppedByTabClose: true
            });
            
            chrome.runtime.sendMessage({ action: "refreshExtensionState" });
            
            showMeetStatus("🔄 Force reset - checking meeting state...");
            
            setTimeout(() => {
                console.log("🔄 Attempting auto-record after reset...");
                forceMeetingRedetection();
                
                if (isInMeeting && autoRecordEnabled && !recordingStarted) {
                    console.log("✅ Conditions met - starting auto recording");
                    startAutoRecording();
                } else {
                    console.log("❌ Conditions not met after reset:", {
                        isInMeeting,
                        autoRecordEnabled,
                        recordingStarted
                    });
                }
            }, 3000);
        } 

        // Message listener for Google Meet
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.action === "updateAutoRecordPermission") {
                autoRecordEnabled = message.enabled;
                console.log(`🔄 Auto record permission updated for ${currentService}:`, autoRecordEnabled);
                sendResponse({ success: true });
            }

            if (message.action === "manualRecordingStarted") {
                console.log("🎬 Manual recording started - showing timer in Meet");
                recordingStarted = true;
                sendResponse({ success: true });
            }
    
            if (message.action === "manualRecordingStopped") {
                console.log("🛑 Manual recording stopped");
                recordingStarted = false;
                sendResponse({ success: true });
            }

            if (message.action === "autoRecordToggledOn") {
                autoRecordEnabled = message.enabled;
                console.log("🔄 Auto-record toggled ON, checking if we're in a meeting...");
                startAutoRecordingImmediately();
                sendResponse({ success: true });
            }

            if (message.action === "checkMeetingStatus") {
                sendResponse({ 
                    isInMeeting, 
                    recording: recordingStarted, 
                    autoRecordEnabled,
                    meetingDuration: getCurrentMeetingDuration()
                });
            }

            if (message.action === "autoStopRecording") {
                stopAutoRecording();
                sendResponse({ success: true });
            }

            if (message.action === "getMeetingDuration") {
                const duration = getCurrentMeetingDuration();
                sendResponse({ 
                    duration: duration,
                    isInMeeting: isInMeeting,
                    startTime: meetingStartTime
                });
            }

            if (message.action === "getLastMeetingStats") {
                chrome.storage.local.get(['lastMeetingDuration', 'lastMeetingEndTime'], (result) => {
                    sendResponse({
                        lastDuration: result.lastMeetingDuration || 0,
                        lastEndTime: result.lastMeetingEndTime || null
                    });
                });
                return true;
            }

            if (message.action === "getMuteStatus") {
                const status = getMuteStatus();
                sendResponse(status);
            }

            if (message.action === "showMeetStatus") {
                const duration = message.duration || 4000;
                showMeetStatus(message.message, duration);
                sendResponse({ success: true });
            }
            
            if (message.action === "updateMeetTimer") {
                const status = document.getElementById('meet-recorder-status');
                if (status && status.textContent.includes('Recording')) {
                    status.textContent = `🔴 Recording... ${message.time}`;
                } else if (isInMeeting && recordingStarted) {
                    showMeetStatus(`🔴 Recording... ${message.time}`);
                }
                sendResponse({ success: true });
            }

            if (message.action === "recordingCompleted") {
                recordingStarted = false;
                if (autoRecordEnabled) {
                    showMeetStatus("✅ Auto Recording Completed & Downloaded");
                } else {
                    showMeetStatus("✅ Recording Completed & Downloaded");
                }
                sendResponse({ success: true });
            }

            if (message.action === "forceResetAndRetry") {
                console.log("📨 Received force reset command");
                forceResetAndRetry();
                sendResponse({ success: true });
            }
            
            return true;
        });      

        // Initialize
        setTimeout(async () => {
            await initializeWithStateRecovery();
            await initializeAutoRecord();
            console.log("🔍 Meet Auto Recorder content script fully loaded with state recovery");
    
            // Show initial status based on auto-record setting
            if (autoRecordEnabled) {
                showMeetStatus("✅ Google Meet's Auto Recording Enabled", 3000);
            } else {
                showMeetStatus("✅ Google Meet's Manual Recorder Is Ready", 3000);
            }
        }, 1000);
    }

    // ==================== MICROSOFT TEAMS ====================
    function teamsContent() {
        console.log("🔍 Initializing Microsoft Teams content script");

        let isInMeeting = false;
        let recordingStarted = false;
        let autoRecordEnabled = false;
        let joinButtonObserver = null;

        function getTeamsMuteStatus() {
            // Teams mute button selectors (you may need to adjust these)
            const muteButton = document.querySelector('[data-tid="toggle-mute"]') ||
                      document.querySelector('button[aria-label*="Mute"]') ||
                      document.querySelector('button[aria-label*="Unmute"]') ||
                      document.querySelector('[aria-label*="microphone"]') ||
                      document.querySelector('[data-tid*="mute"]');
    
            if (muteButton) {
                const ariaLabel = muteButton.getAttribute('aria-label') || '';
                // If aria-label contains "Unmute", that means currently muted
                const isMuted = ariaLabel.toLowerCase().includes('unmute');
                return { isMuted: isMuted };
            }
            return { isMuted: false }; // Default to unmuted if can't detect
        }

        // ==================== TEAMS TIMER FUNCTIONS ====================
        function showTeamsStatus(message, duration = 4000) {
            const existing = document.getElementById('teams-recorder-status');
            
            if (existing && message.includes("Recording...")) {
                existing.innerHTML = message.replace(/\n/g, '<br>');
                return;
            }
    
            if (existing) existing.remove();
    
            const status = document.createElement('div');
            status.id = 'teams-recorder-status';
            status.innerHTML = message.replace(/\n/g, '<br>');
            status.style.cssText = `
                position: fixed;
                top: 150px;
                right: 20px;
                background: rgba(0,0,0,0.95);
                color: white;
                padding: 12px 16px;
                border-radius: 10px;
                font-family: 'Segoe UI', Arial, sans-serif;
                font-size: 14px;
                z-index: 100000;
                font-weight: bold;
                border: 2px solid #6264a7;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                backdrop-filter: blur(10px);
                max-width: 400px;
                word-wrap: break-word;
            `;
    
            document.body.appendChild(status);

            if (!message.includes("Recording...")) {
                setTimeout(() => {
                    const currentStatus = document.getElementById('teams-recorder-status');
                    if (currentStatus && !currentStatus.innerHTML.includes("Recording...")) {
                        currentStatus.remove();
                    }
                }, duration);
            }
        }

        function broadcastTimerUpdateToTeams(timeStr) {
            chrome.runtime.sendMessage({
                action: "updateTeamsTimer",
                time: timeStr
            });
        }

        function broadcastToTeamsTab(message, duration = 4000) {
            chrome.runtime.sendMessage({
                action: "showTeamsStatus", 
                message: message,
                duration: duration
            });
        }

        function startAutoRecordingImmediately() {
            if (isInMeeting && autoRecordEnabled && !recordingStarted) {
                console.log("🚀 Auto-record toggled ON mid-meeting - starting recording immediately");
                showMeetingNotification("autoRecordingStarted");
                startAutoRecording();
            }
        }

        async function initializeAutoRecord() {
            //await checkAutoRecordPermision();
        
            // If auto-record is enabled, immediately check meeting status
            if (autoRecordEnabled) {
                console.log("🔄 Auto-record enabled - checking current meeting state");
                setTimeout(() => {
                    handleMidMeetingAutoRecord();
                    // Additional check after everything loads
                    setTimeout(() => {
                        handleMidMeetingAutoRecord();
                    }, 5000);
                }, 2000);
            }
        }

        async function checkAutoRecordPermission() {
            return new Promise((resolve) => {
                chrome.storage.local.get(['autoRecordPermissions'], (result) => {
                    // Get service-specific permission for Teams
                    autoRecordEnabled = result.autoRecordPermissions?.['teams'] || false;
                    console.log("🔐 Auto record enabled for teams:", autoRecordEnabled);
                    resolve(autoRecordEnabled);
                });
            });
        }

        function findJoinButton() {
            const joinButton = document.getElementById('prejoin-join-button');
            if (joinButton) {
                console.log("🔍 Found Join button:", {
                    id: joinButton.id,
                    text: joinButton.textContent,
                    visible: isElementVisible(joinButton)
                });
                return joinButton;
            }
            
            const fallbackSelectors = [
                'button[data-tid="prejoin-join-button"]',
                'button[aria-label*="Join"]',
                'button[aria-label*="join"]',
                '.join-button',
                'button[title*="Join"]',
                'button[title*="join"]'
            ];
            
            for (const selector of fallbackSelectors) {
                const button = document.querySelector(selector);
                if (button && isElementVisible(button)) {
                    console.log("🔍 Found Join button with selector:", selector);
                    return button;
                }
            }
            
            return null;
        }

        function isElementVisible(element) {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && 
                   style.visibility !== 'hidden' && 
                   style.opacity !== '0' &&
                   rect.width > 0 && 
                   rect.height > 0 &&
                   element.offsetParent !== null;
        }

        function setupJoinButtonClickHandler() {
            document.removeEventListener('click', handleJoinButtonClick, true);
            document.addEventListener('click', handleJoinButtonClick, true);
            console.log("🖱️ Join button click handler activated");
        }

        function handleJoinButtonClick(event) {
            let target = event.target;
            
            while (target && target !== document.body) {
                if (isJoinButton(target)) {
                    console.log("🎯 JOIN BUTTON CLICKED - User is joining meeting");
                    console.log("⏰ Starting 3-second delay before recording...");
                    
                    setTimeout(() => {
                        meetingStarted();
                    }, 3000);
                    
                    break;
                }
                target = target.parentElement;
            }
        }

        function isJoinButton(element) {
            if (!element) return false;
            if (element.id === 'prejoin-join-button') return true;
            if (element.getAttribute('data-tid') === 'prejoin-join-button') return true;
            
            const ariaLabel = element.getAttribute('aria-label') || '';
            const title = element.getAttribute('title') || '';
            const textContent = element.textContent || '';
            
            return (ariaLabel.toLowerCase().includes('join') && 
                    !ariaLabel.toLowerCase().includes('leave')) ||
                   (title.toLowerCase().includes('join') &&
                    !title.toLowerCase().includes('leave')) ||
                   textContent.toLowerCase().includes('join now') ||
                   textContent.trim() === 'Join now';
        }

        function setupLeaveButtonClickHandler() {
            document.removeEventListener('click', handleLeaveButtonClick, true);
            document.addEventListener('click', handleLeaveButtonClick, true);
            console.log("🖱️ Leave button click handler activated");
        }

        function handleLeaveButtonClick(event) {
            let target = event.target;
            
            while (target && target !== document.body) {
                if (isLeaveButton(target)) {
                    console.log("🛑 LEAVE BUTTON CLICKED - Meeting ended by user");

                     if (recordingStarted && !autoRecordEnabled) {
                        console.log("🛑 Manual recording active - will stop recording");
                        // The meetingEnded() function will handle stopping the recording
                    }
        
                    meetingEnded();
                    break;
                }
                target = target.parentElement;
            }
        }

        function isLeaveButton(element) {
            if (!element) return false;
            if (element.id === 'hangup-button') return true;
            
            const ariaLabel = element.getAttribute('aria-label') || '';
            const title = element.getAttribute('title') || '';
            const dataTid = element.getAttribute('data-tid') || '';
            
            return ariaLabel.toLowerCase().includes('leave') ||
                   ariaLabel.toLowerCase().includes('hang up') ||
                   title.toLowerCase().includes('leave') ||
                   title.toLowerCase().includes('hang up') ||
                   dataTid.includes('hangup') ||
                   element.classList.contains('hangup-button');
        }

        function meetingStarted() {
            if (isInMeeting) return;
            
            const startTime = new Date().toLocaleTimeString();
            console.log(`🎯 MEETING STARTED - 3-second delay completed at ${startTime}`);
            isInMeeting = true;
            
            if (autoRecordEnabled && !recordingStarted) {
                console.log("🎬 AUTO RECORDING - Starting recording after delay");
                startAutoRecording();
            } else {
                console.log("ℹ️ Auto recording not enabled or already recording");
            }
            
            showMeetingNotification("started");
            chrome.storage.local.set({ isInMeeting: isInMeeting });
        }

        function meetingEnded() {
            if (!isInMeeting) return;
            
            const endTime = new Date().toLocaleTimeString();
            console.log(`🎯 MEETING ENDED - Leave button was clicked at ${endTime}`);
            isInMeeting = false;
            
            if (recordingStarted) {
                if (autoRecordEnabled) {
                    console.log("⏹️ AUTO STOPPING - Stopping recording due to meeting end");
                    stopAutoRecording();
                } else {
                    console.log("⏹️ MANUAL RECORDING - Meeting ended, stopping recording");
                    handleManualMeetingEnd();
                }
            }
            
            showMeetingNotification("ended");
            chrome.storage.local.set({ isInMeeting: isInMeeting });
        }

        // ==================== TEAMS MEETING END DETECTION ====================
        function setupTeamsMeetingEndDetection() {
            console.log("🔍 Setting up Teams meeting end detection for manual recording");
    
            // Monitor for meeting end indicators
            const meetingEndObserver = new MutationObserver((mutations) => {
                if (!recordingStarted || autoRecordEnabled) return;
        
                mutations.forEach((mutation) => {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === 1) {
                                checkForMeetingEndIndicators();
                            }
                        });
                    }
                });
            });
    
            meetingEndObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: false
            });
    
            // Also check periodically for meeting end
            const periodicCheck = setInterval(() => {
                if (!recordingStarted || autoRecordEnabled) return;
                checkForMeetingEndIndicators();
            }, 3000);
        }

        function checkForMeetingEndIndicators() {
            // Check if we're still in a meeting
            const stillInMeeting = checkIfInMeeting();
            
            if (!stillInMeeting && isInMeeting && recordingStarted && !autoRecordEnabled) {
                console.log("🛑 Manual recording: Meeting ended - stopping recording");
                handleManualMeetingEnd();
            }
    
            // Update our meeting state
            if (stillInMeeting !== isInMeeting) {
                isInMeeting = stillInMeeting;
                chrome.storage.local.set({ isInMeeting: isInMeeting });
        
                if (!isInMeeting && recordingStarted && !autoRecordEnabled) {
                    console.log("🛑 Manual recording: Meeting state changed to ended - stopping recording");
                    handleManualMeetingEnd();
                }
            }
        }

        function handleManualMeetingEnd() {
            if (!recordingStarted || autoRecordEnabled) return;
    
            console.log("🛑 Manual recording: Meeting ended, stopping recording and downloading");
            showTeamsStatus("🟡 Meeting ended - stopping recording...");
    
            // Stop the recording
            stopManualRecording();
        }

        function stopManualRecording() {
            if (!recordingStarted) return;
    
            console.log("🛑 Stopping manual recording due to meeting end");
            showTeamsStatus("🟡 Meeting ended - stopping recording...");
    
            chrome.runtime.sendMessage({ action: "stopRecordingOnMeetingEnd" });
    
            recordingStarted = false;     
        }

        function startAutoRecording() {
            if (recordingStarted) return;
            
            console.log("🎬 Attempting auto recording start...");
            recordingStarted = true;
            
            chrome.runtime.sendMessage({ 
                action: "autoStartRecording"
            }, (response) => {
                if (response && response.success) {
                    console.log("✅ Auto recording started successfully");
                    showRecordingNotification("started");
                } else {
                    console.log("❌ Auto recording failed to start");
                    recordingStarted = false;
                }
            });
        }

        function startManualRecording() {
            if (recordingStarted) return;
    
            console.log("🎬 Starting manual recording...");
            recordingStarted = true;
    
            // Show recording status immediately
            showTeamsStatus("🔴 Recording... 00:00");
    
            chrome.runtime.sendMessage({ 
                action: "manualRecordingStarted"
            }, (response) => {
                if (response && response.success) {
                    console.log("✅ Manual recording started successfully");
                    showRecordingNotification("started");
                } else {
                    console.log("❌ Manual recording failed to start");
                    recordingStarted = false;
                    showTeamsStatus("❌ Recording failed to start");
                }
            });
        }

        function stopAutoRecording() {
            if (!recordingStarted) return;
            
            console.log("🛑 Attempting auto recording stop...");
            
            chrome.runtime.sendMessage({ action: "autoStopRecording" }, (response) => {
                if (response && response.success) {
                    console.log("✅ Auto recording stopped successfully");
                    recordingStarted = false;
                    showRecordingNotification("stopped");
                } else {
                    console.log("❌ Auto recording failed to stop");
                }
            });
        }

        function showMeetingNotification(type) {
            const existingNotification = document.getElementById('meeting-status-notification');
            if (existingNotification) {
                existingNotification.remove();
            }

            const notification = document.createElement('div');
            notification.id = 'meeting-status-notification';
            
            const currentTime = new Date().toLocaleTimeString();
            
            if (type === "started") {
                notification.style.cssText = `
                    position: fixed;
                    top: 10px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: #4CAF50;
                    color: white;
                    padding: 12px 18px;
                    border-radius: 8px;
                    z-index: 10000;
                    font-family: Arial, sans-serif;
                    font-size: 14px;
                    font-weight: bold;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                    border: 2px solid #45a049;
                `;
                notification.textContent = `🔴 Meeting Started - ${currentTime}`;
            }  else if (type === "autoRecordingStarted") {
                notification.style.cssText = `
                position: fixed;
                top: 10px;
                left: 50%;
                transform: translateX(-50%);
                background: #2196F3;
                color: white;
                padding: 12px 18px;
                border-radius: 8px;
                z-index: 10000;
                font-family: Arial, sans-serif;
                font-size: 14px;
                font-weight: bold;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                border: 2px solid #1976D2;
                `;
                notification.textContent = `🎬 Auto Recording Started - ${currentTime}`;
            } else {
                notification.style.cssText = `
                    position: fixed;
                    top: 10px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: #f44336;
                    color: white;
                    padding: 12px 18px;
                    border-radius: 8px;
                    z-index: 10000;
                    font-family: Arial, sans-serif;
                    font-size: 14px;
                    font-weight: bold;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                    border: 2px solid #d32f2f;
                `;
                notification.textContent = `⏹️ Meeting Ended - ${currentTime}`;
            }
            
            document.body.appendChild(notification);
            
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 5000);
        }

        function showRecordingNotification(type) {
            const notification = document.createElement('div');
            notification.id = 'recording-status-notification';
            notification.style.cssText = `
                position: fixed;
                top: 60px;
                left: 50%;
                transform: translateX(-50%);
                background: ${type === 'started' ? '#2196F3' : '#FF9800'};
                color: white;
                padding: 8px 12px;
                border-radius: 5px;
                z-index: 9999;
                font-family: Arial, sans-serif;
                font-size: 11px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            `;
            notification.textContent = type === 'started' 
                ? '🔴 Recording Started' 
                : '⏹️ Recording Stopped - Downloading...';
            
            document.body.appendChild(notification);
            
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 4000);
        }

        function checkIfInMeeting() {
            // Check for various indicators that we're in a Teams meeting
            const indicators = [
                // Video container
                '[data-tid="video-layout"]',
                '[data-tid="meeting-container"]',
                // Participant list
                '[data-tid="roster-list"]',
                // Meeting controls
                '[data-tid="meeting-controls"]',
                '[data-tid="call-controls"]',
                // Leave button
                '[data-tid="hangup-button"]',
                'button[aria-label*="Leave"]',
                'button[aria-label*="Hang up"]',
                // Active speaker video
                '[data-tid="active-speaker-video"]',
                // More specific meeting indicators
                'div[role="main"][data-tid*="meeting"]',
                '.ts-calling-stage',
                '.call-stage'
            ];
        
            for (const selector of indicators) {
                const element = document.querySelector(selector);
                if (element && isElementVisible(element)) {
                    console.log("✅ Teams meeting detected with selector:", selector);
                    return true;
                }
            }
        
            // Additional check: look for multiple video elements which indicate active meeting
            const videoElements = document.querySelectorAll('video');
            const visibleVideos = Array.from(videoElements).filter(video => 
                video.readyState > 0 && 
                video.videoWidth > 0 && 
                video.videoHeight > 0 &&
                isElementVisible(video)
            );
        
            if (visibleVideos.length > 0) {
                console.log("✅ Teams meeting detected via active video elements:", visibleVideos.length);
                return true;
            }
        
            console.log("❌ No Teams meeting indicators found");
            return false;
        }

        function handleMidMeetingAutoRecord() {
            const inMeeting = checkIfInMeeting();
            console.log("🔍 Mid-meeting auto-record check:", { 
                inMeeting, 
                isInMeeting, 
                autoRecordEnabled, 
                recordingStarted 
            });

            if (inMeeting && !isInMeeting) {
                console.log("🔍 Detected active meeting - updating state");
                isInMeeting = true;
                chrome.storage.local.set({ isInMeeting: true });
                
                if (autoRecordEnabled && !recordingStarted) {
                    console.log("🚀 Auto-record enabled mid-meeting - starting recording");                
                        startAutoRecordingImmediately();
                }
            } else if (inMeeting && isInMeeting && autoRecordEnabled && !recordingStarted) {
                // We're already marked as in meeting but recording hasn't started
                console.log("🚀 Already in meeting with auto-record enabled - starting recording");
                startAutoRecordingImmediately();
            }
        }

        function setupJoinButtonObserver() {
            if (joinButtonObserver) {
                joinButtonObserver.disconnect();
            }

            joinButtonObserver = new MutationObserver((mutations) => {
                let joinButtonAppeared = false;
                
                mutations.forEach((mutation) => {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach(node => {
                            if (node.nodeType === 1 && (
                                node.id === 'prejoin-join-button' || 
                                node.getAttribute('data-tid') === 'prejoin-join-button' ||
                                (node.getAttribute('aria-label') && node.getAttribute('aria-label').toLowerCase().includes('join'))
                            )) {
                                console.log("➕ Join button added to DOM");
                                joinButtonAppeared = true;
                            }
                        });
                    }
                    
                    if (mutation.type === 'attributes' && 
                        (mutation.target.id === 'prejoin-join-button' || 
                         mutation.target.getAttribute('data-tid') === 'prejoin-join-button' ||
                         (mutation.target.getAttribute('aria-label') && mutation.target.getAttribute('aria-label').toLowerCase().includes('join')))) {
                        console.log("⚡ Join button attribute changed:", mutation.attributeName);
                        joinButtonAppeared = true;
                    }
                });
                
                if (joinButtonAppeared) {
                    console.log("🔍 Join button state changed, setting up click handler...");
                    setTimeout(() => {
                        setupJoinButtonClickHandler();
                        setupLeaveButtonClickHandler();
                    }, 500);
                }
            });

            joinButtonObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class', 'aria-hidden', 'disabled', 'id', 'data-tid', 'aria-label', 'title']
            });
        }

        function initializeDetection() {
            // Load auto-record permission on initialization
            checkAutoRecordPermission().then(() => {
                console.log("🔐 Teams auto-record permission loaded:", autoRecordEnabled);

                // Show initial status based on auto-record setting
                if (autoRecordEnabled) {
                    showTeamsStatus("✅ Teams Auto Recording Enabled", 3000);
                } else {
                    showTeamsStatus("✅ Teams Recorder Ready - Manual mode", 3000);
                }

                initializeAutoRecord();
            
                // Then check meeting status
                setTimeout(() => {
                    console.log("🔍 Initial meeting state check...");
                    handleMidMeetingAutoRecord();
                
                    // If auto-record is enabled and we're in a meeting, start recording
                    if (autoRecordEnabled && isInMeeting && !recordingStarted) {
                        console.log("🚀 Auto-record enabled and in meeting - starting recording");
                        setTimeout(() => {
                            startAutoRecordingImmediately();
                        }, 2000);
                    }
                }, 2000);
            });

            setupJoinButtonObserver();
            setupJoinButtonClickHandler();
            setupLeaveButtonClickHandler();
            setupTeamsMeetingEndDetection();
        
            const existingJoinButton = findJoinButton();
            if (existingJoinButton) {
                console.log("✅ Join button already present on page");
            }
        
            // Check if we're already in a meeting on initialization
            setTimeout(() => {
                handleMidMeetingAutoRecord();
            }, 3000);
        
            let lastUrl = location.href;
            const urlObserver = new MutationObserver(() => {
                const url = location.href;
                if (url !== lastUrl) {
                    lastUrl = url;
                    console.log("🔗 URL changed, reinitializing detection...");
                    setTimeout(() => {
                        initializeDetection();
                    }, 2000);
                }
            });
        
            urlObserver.observe(document, { subtree: true, childList: true });
        }

        // Message listener for Teams
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            console.log("📨 Teams content script received:", message.action);
            
            if (message.action === "updateAutoRecordPermission") {
                autoRecordEnabled = message.enabled;
                console.log("🔐 Auto record permission updated:", autoRecordEnabled);
                if (autoRecordEnabled && isInMeeting && !recordingStarted) {
                    console.log("🚀 Auto-record enabled while in Teams meeting - starting recording");
                    setTimeout(() => {
                        startAutoRecordingImmediately();
                    }, 1000);
                }
                sendResponse({ success: true });
            }

            if (message.action === "autoRecordToggledOn") {
                autoRecordEnabled = message.enabled;
                console.log("🔄 Auto-record toggled ON, checking meeting status...");
            
                // Check if we're in a meeting and start recording immediately
                setTimeout(() => {
                    handleMidMeetingAutoRecord();
                }, 500);
            
                sendResponse({ success: true });
            }

            if (message.action === "checkMeetingStatus") {
                const wasInMeeting = isInMeeting;
                handleMidMeetingAutoRecord();

                // If we just detected we're in a meeting and auto-record is enabled, start recording
                if (!wasInMeeting && isInMeeting && autoRecordEnabled && !recordingStarted) {
                    console.log("🚀 Meeting detected with auto-record enabled - starting recording");
                    setTimeout(() => {
                        startAutoRecordingImmediately();
                    }, 1000);
                }

                sendResponse({ 
                    isInMeeting: isInMeeting, 
                    recording: recordingStarted,
                    autoRecordEnabled: autoRecordEnabled
                });
            }

             if (message.action === "manualRecordingStarted") {
                console.log("🎬 Manual recording started - showing timer in Teams");
                recordingStarted = true;
                sendResponse({ success: true });
            }

            if (message.action === "manualRecordingStopped") {
                console.log("🛑 Manual recording stopped");
                recordingStarted = false;
                showTeamsStatus("✅ Recording stopped manually");
                sendResponse({ success: true });
            }

            if (message.action === "showTeamsStatus") {
                const duration = message.duration || 4000;
                showTeamsStatus(message.message, duration);
                sendResponse({ success: true });
            }
    
            if (message.action === "updateTeamsTimer") {
                const status = document.getElementById('teams-recorder-status');
                if (status && status.textContent.includes('Recording')) {
                    status.textContent = `🔴 Recording... ${message.time}`;
                } else if (isInMeeting && recordingStarted) {
                    showTeamsStatus(`🔴 Recording... ${message.time}`);
                }
                sendResponse({ success: true });
            }

            if (message.action === "stopRecordingOnMeetingEnd") {
                if (recordingStarted && !autoRecordEnabled) {
                    console.log("🛑 Manual recording: Meeting ended - stopping recording");
                    stopManualRecording();
                }
                sendResponse({ success: true });
            }

            if (message.action === "recordingCompleted") {
                recordingStarted = false;
                if (autoRecordEnabled) {
                    showTeamsStatus("✅ Auto Recording Completed & Downloaded");
                } else {
                    showTeamsStatus("✅ Recording Completed & Downloaded");
                }
                sendResponse({ success: true });
            }

            if (message.action === "getTeamsMuteStatus") {
                const status = getTeamsMuteStatus();
                sendResponse(status);
            }
            
            return true;
        });        

        // Initialize Teams
        setTimeout(() => {
            initializeDetection();
            console.log("🔍 Teams Auto Recorder initialized");
        }, 1500);
    }

    // ==================== ZOOM ====================
    function zoomContent() {
        console.log("🔍 Initializing Zoom content script");

        let isInMeeting = false;
        let recordingStarted = false;
        let autoRecordEnabled = false;
        let meetingStartTimeout = null;
        let ignoreAutoStopUntil = 0;

        let micActivityCheckInterval = null;
        let micMonitoringActive = false;
        let lastMuteState = null;

        function isMeetingPage() {
            const url = location.href;
            return url.includes("/wc/") && (
                url.includes("/join") ||
                url.includes("/start") ||
                url.match(/\/wc\/\d+/)
            );
        }

        function startMicrophoneMonitoring() {
            if (micMonitoringActive) return;
            
            console.log("🎤🎤🎤 ZOOM: STARTING MUTE DETECTION 🎤🎤🎤");
            micMonitoringActive = true;
            
            micActivityCheckInterval = setInterval(() => {
                const muteBtn = document.querySelector(
                    'button[aria-label*="mute my microphone"], button[aria-label*="unmute my microphone"]'
                );
                
                if (muteBtn) {
                    const label = muteBtn.getAttribute('aria-label') || '';
                    const isMuted = label.toLowerCase().includes('unmute');
                    
                    if (isMuted !== lastMuteState) {
                        lastMuteState = isMuted;
                        console.log(`🎤 ZOOM MUTE STATE: ${isMuted ? '🔇 MUTED' : '🔊 UNMUTED'}`);
                        
                        chrome.runtime.sendMessage({
                            action: "zoomMuteChanged",
                            muted: isMuted
                        });
                    }
                }
            }, 300);
        }

        function stopMicrophoneMonitoring() {
            if (micActivityCheckInterval) {
                clearInterval(micActivityCheckInterval);
                micActivityCheckInterval = null;
            }
            micMonitoringActive = false;
        }

        // ==================== ZOOM STATUS FUNCTIONS ====================
        function showZoomStatus(message, duration = 4000) {
            const existing = document.getElementById('zoom-recorder-status');
        
            if (existing && message.includes("Recording...")) {
                existing.innerHTML = message.replace(/\n/g, '<br>');
                return;
            }
        
            if (existing) existing.remove();
        
            const status = document.createElement('div');
            status.id = 'zoom-recorder-status';
            status.innerHTML = message.replace(/\n/g, '<br>');
            status.style.cssText = `
                position: fixed;
                top: 80px;
                right: 20px;
                background: rgba(0,0,0,0.95);
                color: white;
                padding: 12px 16px;
                border-radius: 10px;
                font-family: 'Segoe UI', Arial, sans-serif;
                font-size: 14px;
                z-index: 100000;
                font-weight: bold;
                border: 2px solid #2D8CFF;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                backdrop-filter: blur(10px);
                max-width: 400px;
                word-wrap: break-word;
            `;
        
            document.body.appendChild(status);

            if (!message.includes("Recording...")) {
                setTimeout(() => {
                    const currentStatus = document.getElementById('zoom-recorder-status');
                    if (currentStatus && !currentStatus.innerHTML.includes("Recording...")) {
                        currentStatus.remove();
                    }
                }, duration);
            }
        }

        function broadcastTimerUpdateToZoom(timeStr) {
            chrome.runtime.sendMessage({
                action: "updateZoomTimer",
                time: timeStr
            });
        }

        function broadcastToZoomTab(message, duration = 4000) {
            chrome.runtime.sendMessage({
                action: "showZoomStatus", 
                message: message,
                duration: duration
            });
        }

        // Check auto record permission on load
        checkAutoRecordPermission();

        async function checkAutoRecordPermission() {
            return new Promise((resolve) => {
                chrome.storage.local.get(['autoRecordPermissions'], (result) => {
                    // Get service-specific permission for Zoom
                    autoRecordEnabled = result.autoRecordPermissions?.['zoom'] || false;
                    console.log("🔐 Auto record enabled for zoom:", autoRecordEnabled);
                    resolve(autoRecordEnabled);
                });
            });
        }

        function startMeetingDetection() {
            console.log("🚀 Starting Zoom meeting detection...");
            
            let lastMeetingState = false;
            
            setInterval(() => {
                const isOnMeetingPage = isMeetingPage();
                
                if (isOnMeetingPage && !lastMeetingState && !isInMeeting) {
                    console.log("🎯 ZOOM MEETING PAGE DETECTED!");
                    startMeetingWithDelay();
                }
                
                if (!isOnMeetingPage && lastMeetingState && isInMeeting) {
                    if (Date.now() < ignoreAutoStopUntil) {
                        console.log("⏱️ Auto-stop BLOCKED - small X button was clicked");
                        ignoreAutoStopUntil = 0;
                    } else {
                        console.log("🛑 ZOOM MEETING ENDED - URL changed!");
                        meetingEnded();
                    }
                }
                
                lastMeetingState = isOnMeetingPage;
            }, 1000);
        }

        function setupEndButtonDetection() {
            console.log("🖱️ ZOOM LEAVE/END BUTTON DETECTION - ACTIVATED!");
            
            function findInShadow(element, searchText) {
                try {
                    if (element.textContent && element.textContent.toLowerCase().includes(searchText.toLowerCase())) {
                        return element;
                    }
                    if (element.children) {
                        for (let child of element.children) {
                            const result = findInShadow(child, searchText);
                            if (result) return result;
                        }
                    }
                    if (element.shadowRoot) {
                        for (let child of element.shadowRoot.children) {
                            const result = findInShadow(child, searchText);
                            if (result) return result;
                        }
                    }
                } catch (e) {}
                return null;
            }
        
            function attachLeaveButtonListener() {
                let leaveBtn = document.querySelector('#wc-footer > div.footer__inner.leave-option-container > div:nth-child(1) > div > div > button:nth-child(2)');
                let endForAllBtn = document.querySelector('#wc-footer > div.footer__inner.leave-option-container > div:nth-child(1) > div > div > button.zmu-btn.leave-meeting-options__btn.leave-meeting-options__btn--default.leave-meeting-options__btn--danger.zmu-btn--default.zmu-btn__outline--white');
                
                if (!leaveBtn || !endForAllBtn) {
                    const container = document.querySelector('.leave-option-container');
                    if (container) {
                        const btns = container.querySelectorAll('button');
                        btns.forEach((btn) => {
                            const text = btn.textContent.toLowerCase().trim();
                            if (!leaveBtn && (text === 'leave meeting' || text.includes('leave'))) {
                                leaveBtn = btn;
                            }
                            if (!endForAllBtn && (text === 'end meeting for all' || btn.className.includes('danger'))) {
                                endForAllBtn = btn;
                            }
                        });
                    }
                }
                
                if (leaveBtn && !leaveBtn.hasAttribute('data-leave-listener')) {
                    leaveBtn.setAttribute('data-leave-listener', 'true');
                    leaveBtn.addEventListener('click', () => {
                        console.log("🎯 LEAVE MEETING CLICKED - STOPPING NOW");
                        stopRecording();
                    });
                    console.log("✅ LISTENER ATTACHED TO LEAVE MEETING BUTTON");
                }
                
                if (endForAllBtn && !endForAllBtn.hasAttribute('data-end-listener')) {
                    endForAllBtn.setAttribute('data-end-listener', 'true');
                    endForAllBtn.addEventListener('click', () => {
                        console.log("🎯 END MEETING FOR ALL CLICKED - STOPPING NOW");
                        stopRecording();
                    });
                    console.log("✅ LISTENER ATTACHED TO END MEETING FOR ALL BUTTON");
                }
            }
        
            attachLeaveButtonListener();
            setInterval(() => {
                attachLeaveButtonListener();
            }, 2000);
        }

        function setupURLChangeDetection() {
            console.log("🌐 Setting up Zoom URL change detection...");
            
            let lastURL = window.location.href;
            
            setInterval(() => {
                const currentURL = window.location.href;
                
                if (currentURL !== lastURL) {
                    const wasMeetingURL = lastURL.includes('/wc/') && (
                        lastURL.includes('/start') || 
                        lastURL.includes('/join') ||
                        lastURL.match(/\/wc\/\d+/)
                    );
                    
                    const isMeetingURL = currentURL.includes('/wc/') && (
                        currentURL.includes('/start') || 
                        currentURL.includes('/join') ||
                        currentURL.match(/\/wc\/\d+/)
                    );
                    
                    if (wasMeetingURL && !isMeetingURL && isInMeeting) {
                        if (Date.now() < ignoreAutoStopUntil) {
                            console.log("⏱️ URL CHANGE AUTO-STOP BLOCKED - small X button was clicked");
                            ignoreAutoStopUntil = 0;
                        } else {
                            console.log("🛑 URL CHANGED - USER LEFT MEETING!");
                            meetingEnded();
                        }
                    }
                    
                    lastURL = currentURL;
                }
            }, 500);
        }

        function startMeetingWithDelay() {
            if (isInMeeting) return;
            
            if (meetingStartTimeout) {
                clearTimeout(meetingStartTimeout);
            }
            
            console.log("⏰ Zoom: Starting 3-second delay before recording...");
            
            if (autoRecordEnabled) {
                showZoomStatus("🟡 Auto recording starting in 3 seconds...");
            }
            
            meetingStartTimeout = setTimeout(() => {
                console.log("⏰ Zoom: 3-second delay completed - starting meeting");
                meetingStarted();
            }, 3000);
        }

        function stopRecording() {
            console.log("🛑🛑🛑 STOP RECORDING CALLED 🛑🛑🛑");
            
            if (meetingStartTimeout) {
                clearTimeout(meetingStartTimeout);
                meetingStartTimeout = null;
            }
            
            stopMicrophoneMonitoring();

            chrome.runtime.sendMessage({ action: "autoStopRecording" }, (response) => {
                console.log("✅ STOP MESSAGE SENT - Response:", response);
            });
            
            recordingStarted = false;
            isInMeeting = false;
            hideRecordingPopup();
        }

        // EMERGENCY STOP - WHEN NORMAL STOP FAILS
        function emergencyStop() {
            console.log("🚨🚨🚨 ZOOM EMERGENCY STOP 🚨🚨🚨");
            
            try {
                // Send multiple stop commands
                chrome.runtime.sendMessage({ action: "autoStopRecording" });
                chrome.runtime.sendMessage({ action: "stopAllRecordings" });
                chrome.runtime.sendMessage({ action: "emergencyStop" });
                
                // Force cleanup
                isInMeeting = false;
                recordingStarted = false;
                
                // Clear storage
                chrome.storage.local.remove(['isRecording', 'recordingTime', 'recordingStartTime']);
                
                // Hide all UI
                hideRecordingPopup();
                hideRecordingTimer();
                
                console.log("✅ ZOOM EMERGENCY STOP: Completed");
            } catch (error) {
                console.error("❌ ZOOM EMERGENCY STOP: Error:", error);
            }
        }

        function meetingStarted() {
            if (isInMeeting && recordingStarted) return;

            console.log("🎯 ZOOM MEETING STARTED");
            isInMeeting = true;

            startMicrophoneMonitoring();

            checkAutoRecordPermission().then(() => {
                if (autoRecordEnabled && !recordingStarted) {
                    console.log("🎬 ZOOM AUTO RECORDING STARTING");
                    startAutoRecording();
                }
            });

            showMeetingNotification("started");
            chrome.storage.local.set({ isInMeeting: isInMeeting });
        }

        function meetingEnded() {
            if (!isInMeeting) return;
            
            if (Date.now() < ignoreAutoStopUntil) {
                console.log("⏱️ Auto-stop BLOCKED - small X button was clicked");
                return;
            }
            
            console.log("🎯 ZOOM MEETING ENDED - EXECUTING STOP SEQUENCE");
            isInMeeting = false;

            stopMicrophoneMonitoring();
            
            if (recordingStarted) {
                console.log("⏹️ RECORDING ACTIVE - STOPPING AND DOWNLOADING NOW");
                stopAutoRecording();
            }
            
            recordingStarted = false;
            showMeetingNotification("ended");
            chrome.storage.local.set({ isInMeeting: isInMeeting });
        }

        function startAutoRecording() {
            if (recordingStarted) {
                console.log("⚠️ Zoom: Already recording, ignoring start request");
                return;
            }
            
            console.log("🎬 Zoom: Starting auto recording...");
            recordingStarted = true;
            
            showRecordingPopup();
            
            // Only show auto-recording status if auto-record is enabled
            if (autoRecordEnabled) {
                showZoomStatus("🔴 Auto Recording Started");
            } else {
                showZoomStatus("🔴 Recording Started");
            }

            chrome.runtime.sendMessage({ 
                action: "autoStartRecording",
                service: 'zoom'
            }, (response) => {
                if (response && response.success) {
                    console.log("✅ Zoom: Recording started successfully");
                    showRecordingNotification("started");
                } else {
                    console.log("❌ Zoom: Recording failed to start");
                    recordingStarted = false;
                    hideRecordingPopup();
                    showZoomStatus("❌ Auto Recording Failed");
                }
            });
        }

        function stopAutoRecording() {
            if (!recordingStarted) {
                console.log("⚠️ Zoom: stopAutoRecording called but not recording");
                return;
            }
            
            console.log("🛑 Zoom: Stopping recording and downloading...");
            
            // Show appropriate status based on recording mode
            if (autoRecordEnabled) {
                showZoomStatus("🟡 Auto Recording Stopped - Downloading...");
            } else {
                showZoomStatus("🟡 Recording Stopped - Downloading...");
            }
            
            // CLEAN UP ALL UI ELEMENTS
            hideRecordingPopup();
            hideRecordingTimer();
            
            chrome.runtime.sendMessage({ action: "autoStopRecording" }, (response) => {
                if (response && response.success) {
                    console.log("✅ Zoom: Recording stopped and download started successfully");
                    recordingStarted = false;
                    showRecordingNotification("stopped");
                } else {
                    console.log("❌ Zoom: Recording failed to stop");
                    recordingStarted = false;
                    if (autoRecordEnabled) {
                        showZoomStatus("❌ Auto Recording Stop Failed");
                    } else {
                        showZoomStatus("❌ Recording Stop Failed");
                    }
                }
            });
        }

        // UI FUNCTIONS
        function showMeetingNotification(type) {
            const existingNotification = document.getElementById('meeting-status-notification');
            if (existingNotification) existingNotification.remove();

            const notification = document.createElement('div');
            notification.id = 'meeting-status-notification';
            
            const currentTime = new Date().toLocaleTimeString();
            
            if (type === "started") {
                notification.style.cssText = `
                    position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
                    background: #2D8CFF; color: white; padding: 12px 18px; border-radius: 8px;
                    z-index: 10000; font-family: Arial; font-size: 14px; font-weight: bold;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3); border: 2px solid #1A5EB8;
                `;
                notification.textContent = `🔴 Zoom Meeting Started - ${currentTime}`;
            } else {
                notification.style.cssText = `
                    position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
                    background: #f44336; color: white; padding: 12px 18px; border-radius: 8px;
                    z-index: 10000; font-family: Arial; font-size: 14px; font-weight: bold;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3); border: 2px solid #d32f2f;
                `;
                notification.textContent = `⏹️ Zoom Meeting Ended - ${currentTime}`;
            }
            
            document.body.appendChild(notification);
            setTimeout(() => notification.remove(), 5000);
        }

        function showRecordingNotification(type) {
            const notification = document.createElement('div');
            notification.id = 'recording-status-notification';
            notification.style.cssText = `
                position: fixed; top: 60px; left: 50%; transform: translateX(-50%);
                background: ${type === 'started' ? '#2196F3' : '#FF9800'}; color: white;
                padding: 8px 12px; border-radius: 5px; z-index: 9999; font-family: Arial;
                font-size: 11px; box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            `;
            notification.textContent = type === 'started' 
                ? '🔴 Zoom Recording Started' 
                : '⏹️ Zoom Recording Stopped - Downloading...';
            
            document.body.appendChild(notification);
            setTimeout(() => notification.remove(), 4000);
        }

        function showRecordingPopup() {
            // This function now only updates the top-right status via showZoomStatus
            // The bottom-right red popup is intentionally not created
            
            // Just log that recording popup was requested
            console.log("🎬 Recording popup requested - using top-right status instead");
            
            // Ensure top-right status shows recording
            if (autoRecordEnabled) {
                showZoomStatus("🔴 Auto Recording Started");
            } else {
                showZoomStatus("🔴 Recording Started");
            }
        }

        function updateRecordingTimer(time) {
            const timerElement = document.getElementById('recording-timer');
            if (timerElement) timerElement.textContent = time;
        }

        function hideRecordingPopup() {
            const popup = document.getElementById('recording-live-popup');
            if (popup) {
                console.log("🗑️ Removing Zoom recording popup");
                popup.remove();
            }
        }

        function hideRecordingTimer() {
            const timer = document.getElementById('recording-timer');
            if (timer) {
                console.log("🗑️ Removing Zoom recording timer");
                timer.remove();
            }
        }

        function resetRecordingState() {
            recordingStarted = false;
            isInMeeting = false;
            if (meetingStartTimeout) {
                clearTimeout(meetingStartTimeout);
                meetingStartTimeout = null;
            }
            hideRecordingPopup();
            hideRecordingTimer();
            console.log("🔄 Zoom: Recording state reset");
        }

        // Message listener for Zoom
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            console.log("📨 Zoom content script received:", message.action);
            
            if (message.action === "updateAutoRecordPermission") {
                autoRecordEnabled = message.enabled;
                console.log("🔐 Zoom: Auto record permission updated:", autoRecordEnabled);
                
                // Show appropriate status when permission changes
                if (autoRecordEnabled) {
                    showZoomStatus("✅ Auto Recording Enabled for Zoom", 4000);
                } else {
                    showZoomStatus("✅ Auto Recording Disabled for Zoom", 4000);
                }
    
                sendResponse({ success: true });
            }

            if (message.action === "getZoomMuteStatus") {
                // Get current mute state from the monitored variable
                sendResponse({ muted: lastMuteState !== null ? lastMuteState : true });
            }

            if (message.action === "showZoomStatus") {
                const duration = message.duration || 4000;
                showZoomStatus(message.message, duration);
                sendResponse({ success: true });
            }

            if (message.action === "updateZoomTimer") {
                const status = document.getElementById('zoom-recorder-status');
                if (status && status.textContent.includes('Recording')) {
                    status.textContent = `🔴 Recording... ${message.time}`;
                } else if (isInMeeting && recordingStarted) {
                    showZoomStatus(`🔴 Recording... ${message.time}`);
                }
                sendResponse({ success: true });
            }

            if (message.action === "autoRecordToggledOn") {
                autoRecordEnabled = message.enabled;
                console.log("🔄 Zoom: Auto-record toggled ON, checking meeting status...");
    
                // Check if we're in a meeting and start recording immediately
                setTimeout(() => {
                    const meetingDetected = document.querySelector('.video-container') || 
                               document.querySelector('.zm-btn.join-audio-by-voip__join-btn');
                    if (meetingDetected && !isInMeeting) {
                        console.log("🚀 Zoom: Meeting detected with auto-record enabled - starting recording");
                        showZoomStatus("🟡 Auto recording starting in 3 seconds...");
                        startMeetingWithDelay();
                    } else if (isInMeeting && !recordingStarted) {
                        console.log("🚀 Zoom: Already in meeting with auto-record enabled - starting recording");
                        showZoomStatus("🟡 Auto recording starting now...");
                        startAutoRecording();
                    } else if (isInMeeting && !autoRecordEnabled) {
                        // If we're in meeting but auto-record is disabled, show ready status
                        showZoomStatus("✅ In Zoom meeting - Ready for manual recording");
                    }
                }, 500);

                sendResponse({ success: true });
            }

            if (message.action === "checkMeetingStatus") {
                sendResponse({ 
                    isInMeeting: isInMeeting, 
                    recording: recordingStarted,
                    autoRecordEnabled: autoRecordEnabled
                });
            }

            if (message.action === "updateRecordingTimer") {
                updateRecordingTimer(message.time);
                sendResponse({ success: true });
            }

            if (message.action === "showRecordingPopup") {
                showRecordingPopup();
                sendResponse({ success: true });
            }

            if (message.action === "hideRecordingPopup") {
                hideRecordingPopup();
                sendResponse({ success: true });
            }

            if (message.action === "manualRecordingStarted") {
                console.log("🎬 Zoom: Manual recording started");
                recordingStarted = true;
                showRecordingPopup();
                showZoomStatus("🔴 Recording Started");                
                sendResponse({ success: true });
            }

            if (message.action === "manualRecordingStopped") {
                console.log("🛑 Zoom: Manual recording stopped");
                recordingStarted = false;
                showZoomStatus("🟡 Recording Stopped - Downloading...");                
                hideRecordingPopup();
                sendResponse({ success: true });
            }

            if (message.action === "recordingCompleted") {
                recordingStarted = false;
                if (autoRecordEnabled) {
                    showZoomStatus("✅ Auto Recording Completed & Downloaded");
                } else {
                    showZoomStatus("✅ Recording Completed & Downloaded");
                }
                sendResponse({ success: true });
            }

            if (message.action === "showPermissionError") {
                showZoomStatus("❌ Permission needed - please click extension icon once to grant access", 6000);
                sendResponse({ success: true });
            }
            
            return true;
        });

        // Page load detection
        window.addEventListener('load', () => {
            console.log("🔄 Zoom: Page loaded - resetting recording states");
            resetRecordingState();
            checkAutoRecordPermission().then(() => {
                console.log("🔄 Zoom: Auto record permission rechecked:", autoRecordEnabled);
            });
        });

        setTimeout(() => {
            console.log("🔧 Starting Zoom Auto Recorder...");
            startMeetingDetection();
            setupEndButtonDetection();
            setupURLChangeDetection();
    
            window.addEventListener('beforeunload', () => {
                if (isInMeeting && recordingStarted) {
                    console.log("🚨 PAGE UNLOADING - FORCE STOPPING RECORDING");
                    chrome.runtime.sendMessage({ action: "autoStopRecording" });
                }
            });
    
            console.log("✅ Zoom Auto Recorder initialized");
        }, 1000);

        console.log("🔍 Zoom Auto Recorder content script loaded");
    }
})();
