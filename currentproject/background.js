// UNIFIED BACKGROUND.JS - Google Meet, Microsoft Teams & Zoom (with Huddle support)

(function() {
    'use strict';

    let userPermissionGranted = false;
    let currentRecordingTab = null;
    let isAutoRecording = false;
    let isExtendingToMeet = false;
    let extendTransitionTime = 0;
    let autoStartTimeout = null;
    let autoRecordPermissions = {};

    // Service detection
    function detectService(url) {
        if (url.includes('meet.google.com')) return 'gmeet';
        if (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) return 'teams';
        if (url.includes('zoom.us') || url.includes('zoom.com')) return 'zoom'; 
        if (url.includes('chat.google.com') || url.includes('mail.google.com')) return 'gchat';
        return null;
    }

    // Load saved permission state
    chrome.storage.local.get(['autoRecordPermissions'], (result) => {
        console.log("🔐 Auto record permissions:", result.autoRecordPermissions);
    });

    async function restoreAutoRecordState() {
        const result = await chrome.storage.local.get(['autoRecordPermissions']);
        autoRecordPermissions = result.autoRecordPermissions || {};
        console.log("🔧 Restored auto-record permissions:", autoRecordPermissions);
    
        // Notify all tabs about the current permissions
        notifyAllTabsOfPermissions();
    }

    function notifyAllTabsOfPermissions() {
        // Notify Google Meet tabs
        chrome.tabs.query({ url: ["https://*.meet.google.com/*"] }, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    action: "updateAutoRecordPermission",
                    enabled: autoRecordPermissions['gmeet'] || false
                }, () => {});
            });
        });
    
        // Notify Teams tabs
        chrome.tabs.query({ url: ["https://*.teams.microsoft.com/*", "https://*.teams.live.com/*"] }, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    action: "updateAutoRecordPermission",
                    enabled: autoRecordPermissions['teams'] || false            
                }, () => {});
            });
        });
        
        // Notify Zoom tabs
        chrome.tabs.query({ url: ["https://*.zoom.us/*", "https://*.zoom.com/*"] }, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    action: "updateAutoRecordPermission",
                    enabled: autoRecordPermissions['zoom'] || false            
                }, () => {});
            });
        });

        // Notify Google Chat tabs (for Huddle)
        chrome.tabs.query({ url: ["https://chat.google.com/*", "https://mail.google.com/*"] }, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    action: "updateAutoRecordPermission",
                    enabled: autoRecordPermissions['gchat'] || false,
                    service: 'gchat'
                }, () => {});
            });
        });
    }

    chrome.runtime.onStartup.addListener(() => {
        console.log("🔄 Extension starting up - restoring auto-record state");
        restoreAutoRecordState();
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status === 'complete' &&
    tab.url &&
    tab.url.includes('meet.google.com')) {

    console.log("🔄 Meet opened from Huddle");

    isExtendingToMeet = true;
    extendTransitionTime = Date.now();

    setTimeout(() => {

    console.log("✅ Transition timeout finished");

    isExtendingToMeet = false;

}, 10000);
}

        if (changeInfo.status === "complete" && tab.url) {
            const service = detectService(tab.url);
                        
            if (service === 'gmeet') {
                // Check if this is an extend operation
                chrome.storage.local.get(['isExtendingToMeet', 'extendTransitionTime', 'forceMeetRecording'], async (result) => {
                    if (result.isExtendingToMeet) {
    console.log("🔄 EXTEND TRANSITION - Meet tab opened from Huddle");

    const transitionTime = result.extendTransitionTime || 0;
    const timeSinceExtend = Date.now() - transitionTime;

    if (timeSinceExtend < 10000) {
        console.log("✅ Valid extend transition detected");

        // Clear extend flags
        chrome.storage.local.remove([
            'isExtendingToMeet',
            'extendTransitionTime',
            'forceMeetRecording'
        ]);

        // CLOSE OLD RECORDER TABS FIRST
        chrome.tabs.query({
            url: chrome.runtime.getURL("recorder.html")
        }, (tabs) => {

            console.log("🧹 Closing old recorder tabs:", tabs.length);

            tabs.forEach(tab => {
                chrome.tabs.remove(tab.id, () => {
                    console.log("✅ Closed old recorder tab:", tab.id);
                });
            });

            // WAIT before opening NEW recorder
            setTimeout(() => {

                console.log("🎬 Starting NEW Meet recorder");

                startRecordingForTab(tabId, 'gmeet');

                chrome.tabs.sendMessage(tabId, {
                    action: "showMeetStatus",
                    message: "🎬 Recording continued in Meet tab",
                    duration: 5000
                });

            }, 2000);
        });

    } else {
        console.log("⚠️ Extend flag expired");

        chrome.storage.local.remove([
            'isExtendingToMeet',
            'extendTransitionTime',
            'forceMeetRecording'
        ]);
    }
}
                });
            }            
            
            if (service === 'gmeet') {
                handleGmeetTabUpdate(tabId, tab);
            } else if (service === 'teams') {
                handleTeamsTabUpdate(tabId, tab);
            } else if (service === 'zoom') {
                handleZoomTabUpdate(tabId, tab);
            } else if (service === 'gchat') {
                handleGchatTabUpdate(tabId, tab);
            }
        }
    });

    // Auto-detect huddle tabs (for Google Chat)
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
        if (changeInfo.url && (changeInfo.url.includes('huddle') || changeInfo.url.includes('meet.google.com/_/frame'))) {
            console.log("🎯 Huddle detected:", tabId);
            
            const result = await chrome.storage.local.get(['autoRecordPermissions']);
            const autoRecordEnabled = result.autoRecordPermissions?.['gchat'] || false;
            
            if (autoRecordEnabled) {
                console.log("🎬 Auto-recording huddle");
                setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, { action: "startRecording", isAuto: true, service: 'gchat' });
                }, 3000);
            }
        }
    });

    async function handlePermissionRecovery(tabId, service) {
        console.log("🔄 Attempting permission recovery for tab:", tabId);
    
        await new Promise(resolve => setTimeout(resolve, 3000));
    
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab) {
                console.log("✅ Tab is accessible, retrying recording...");
            
                chrome.tabs.create({
                    url: chrome.runtime.getURL("recorder.html"),
                    active: false
                }, (recorderTab) => {
                    console.log("✅ New recorder tab opened:", recorderTab.id);
                    
                    const startRecordingWithRetry = (retryCount = 0) => {
                        console.log(`🔄 Retrying recording start (attempt ${retryCount + 1})...`);
                        
                        chrome.tabs.sendMessage(recorderTab.id, { 
                            action: "startRecording", 
                            tabId: tabId,
                            autoRecord: true,
                            service: service
                        }, (response) => {
                            if (chrome.runtime.lastError) {
                                console.log(`❌ Recorder tab not ready (attempt ${retryCount + 1}/3), retrying...`);
                                if (retryCount < 2) {
                                    setTimeout(() => startRecordingWithRetry(retryCount + 1), 1000);
                                } else {
                                    console.error("❌ Failed to start recording after 3 attempts");
                                    chrome.tabs.remove(recorderTab.id);
                                }
                            } else {
                                console.log("✅ Recording started successfully after permission recovery");
                            }
                        });
                    };
                    
                    setTimeout(() => startRecordingWithRetry(), 1500);
                });
            }
        } catch (error) {
            console.log("❌ Tab still not accessible:", error);
        }
    }

    // ==================== GOOGLE MEET HANDLERS ====================
    async function handleGmeetTabUpdate(tabId, tab) {
        console.log("✅ Meet tab detected:", tabId, tab.url);
    
        const result = await chrome.storage.local.get(['autoRecordPermissions']);
        const gmeetAutoRecordEnabled = result.autoRecordPermissions?.['gmeet'] || false;
    
        if (gmeetAutoRecordEnabled) {
            console.log("🎬 Auto record enabled for Google Meet - monitoring meeting state");
        }
    }

    function closeAllRecorderTabs() {
        return new Promise((resolve) => {
            chrome.tabs.query({ url: chrome.runtime.getURL("recorder.html") }, (tabs) => {
                if (tabs.length === 0) {
                    console.log("✅ No recorder tabs found to close");
                    resolve();
                    return;
                }
                
                let closedCount = 0;
                tabs.forEach(tab => {
                    chrome.tabs.remove(tab.id, () => {
                        closedCount++;
                        console.log(`✅ Background closed recorder tab: ${tab.id}`);
                        
                        if (closedCount === tabs.length) {
                            console.log("✅ Background: All recorder tabs closed");
                            resolve();
                        }
                    });
                });
            });
        });
    }

    async function handleGmeetAutoStart(message, sender) {
        console.log("🎬 Auto-start recording requested from tab:", sender.tab?.id);

        if (autoStartTimeout) {
            clearTimeout(autoStartTimeout);
            autoStartTimeout = null;
        }

        if (!sender.tab?.id) {
            console.log("❌ No sender tab ID");
            return { success: false, reason: "no_tab_id" };
        }

        const result = await chrome.storage.local.get(['autoRecordPermissions']);
        const gmeetAutoRecordEnabled = result.autoRecordPermissions?.['gmeet'] || false;
    
        if (!gmeetAutoRecordEnabled) {
            console.log("❌ Auto recording denied - no permission for Google Meet");
            return { success: false, reason: "no_permission" };
        }

        console.log("🔄 Resetting states before auto-start...");
        currentRecordingTab = null;
        isAutoRecording = false;

        await chrome.storage.local.set({ 
            isRecording: false,
            recordingStoppedByTabClose: true 
        });

        console.log("✅ Starting auto recording for tab:", sender.tab.id);
        currentRecordingTab = sender.tab.id;
        isAutoRecording = true;

        setTimeout(() => {
            startRecordingForTab(sender.tab.id, 'gmeet');
        }, 2000);

        return { success: true };
    }

    async function stopRecordingOnMeetingEnd() {
        return new Promise((resolve) => {
            chrome.tabs.query({
                url: chrome.runtime.getURL("recorder.html")
            }, (tabs) => {
                if (tabs.length > 0) {
                    let completed = 0;
                    tabs.forEach(tab => {
                        chrome.tabs.sendMessage(tab.id, {
                            action: "stopRecording",
                            forceAutoDownload: true
                        }, (_response) => {
                            if (chrome.runtime.lastError) {
                                console.log("▲ Recorder tab not responding");
                            } else {
                                console.log("■ Auto-download command sent");
                            }
                            completed++;
                            if (completed == tabs.length) {
                                currentRecordingTab = null;
                                isAutoRecording = false;
                                resolve();
                            }
                        });
                    });
                } else {
                    console.log("▲ No recorder tabs found");
                    currentRecordingTab = null;
                    isAutoRecording = false;
                    resolve();
                }
            });
        });
    }

    function notifyAllGmeetTabs(enabled) {
        chrome.tabs.query({ url: ["https://*.meet.google.com/*"] }, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    action: "updateAutoRecordPermission",
                    enabled: enabled
                });
            });
        });
    }

    // ==================== GOOGLE CHAT / HUDDLE HANDLERS ====================
    function handleGchatTabUpdate(tabId, tab) {
        console.log("✅ Google Chat tab detected:", tabId, tab.url);
        
        chrome.storage.local.get(['autoRecordPermissions'], (result) => {
            const autoRecordEnabled = result.autoRecordPermissions?.['gchat'] || false;
            if (autoRecordEnabled) {
                console.log("🎬 Auto record enabled for Google Chat - will record huddles");
            }
        });
    }

    function notifyAllGchatTabs(enabled) {
        chrome.tabs.query({ url: ["https://chat.google.com/*", "https://mail.google.com/*"] }, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    action: "updateAutoRecordPermission",
                    enabled: enabled,
                    service: 'gchat'
                });
            });
        });
    }

    // ==================== MICROSOFT TEAMS HANDLERS ====================
    function handleTeamsTabUpdate(tabId, tab) {
        console.log("✅ Teams tab detected:", tabId, tab.url);
        
        chrome.storage.local.get(['autoRecordPermissions'], (result) => {
            if (result.autoRecordPermissions) {
                console.log("🎬 Auto recording enabled - Waiting for Join button click...");
                
                setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, { action: "checkMeetingStatus" }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.log("⚠️ Content script not ready yet, will detect meeting when Join button is clicked");
                            return;
                        }
                        
                        if (response && response.isInMeeting && !response.recording) {
                            console.log("✅ Meeting already in progress - starting auto recording");
                            startRecordingForTab(tabId, 'teams');
                        }
                    });
                }, 3000);
            }
        });
    }

    function handleTeamsAutoStart(sender) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`🎬 Auto starting recording - Join button clicked (+3s delay completed) at ${timestamp}`);
        console.log("📍 Source tab:", sender.tab.id, sender.tab.url);
        startRecordingForTab(sender.tab.id, 'teams');
        return { success: true };
    }

    function notifyAllTeamsTabs(enabled) {
        chrome.tabs.query({url: ["https://*.teams.microsoft.com/*", "https://*.teams.live.com/*"]}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    action: "updateAutoRecordPermission",
                    enabled: enabled
                });
            });
        });
    }

    // ==================== ZOOM HANDLERS ====================
    async function handleZoomTabUpdate(tabId, tab) {
        console.log("✅ Zoom tab detected:", tabId, tab.url);
    
        const result = await chrome.storage.local.get(['autoRecordPermissions']);
        const zoomAutoRecordEnabled = result.autoRecordPermissions?.['zoom'] || false;
    
        if (zoomAutoRecordEnabled) {
            console.log("🎬 Auto record enabled for Zoom - monitoring meeting state");
        
            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { action: "checkMeetingStatus" }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.log("⚠️ Zoom content script not ready yet");
                        return;
                    }
                
                    if (response && response.isInMeeting && !response.recording) {
                        console.log("✅ Zoom meeting already in progress - starting auto recording");
                        startRecordingForTab(tabId, 'zoom');
                    }
                });
            }, 3000);
        }
    }

    async function handleZoomAutoStart(sender) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`🎬 Auto starting recording for Zoom at ${timestamp}`);
        console.log("📍 Source tab:", sender.tab.id, sender.tab.url);
        
        const result = await chrome.storage.local.get(['isRecording']);
        if (result.isRecording) {
            console.log("⚠️ Already recording - ignoring Zoom auto-record request");
            return { success: false, reason: "already_recording" };
        }
        
        if (currentRecordingTab && !isAutoRecording) {
            console.log("⚠️ Already recording in tab:", currentRecordingTab);
            return { success: false, reason: "already_recording" };
        }
        
        startRecordingForTab(sender.tab.id, 'zoom');
        return { success: true };
    }

    function notifyAllZoomTabs(enabled) {
        chrome.tabs.query({url: ["https://*.zoom.us/*", "https://*.zoom.com/*"]}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    action: "updateAutoRecordPermission",
                    enabled: enabled
                });
            });
        });
    }

    // ==================== COMMON FUNCTIONS ====================
    function startRecordingForTab(tabId, service) {
        if (currentRecordingTab && !isAutoRecording) {
            console.log("⚠️ Already recording in tab:", currentRecordingTab);
            return;
        }

        console.log(`🎬 Starting recording for ${service} tab:`, tabId);
        
        
        chrome.tabs.create({
            url: chrome.runtime.getURL("recorder.html"),
            active: false
        }, (recorderTab) => {
            console.log("✅ Recorder tab opened:", recorderTab.id);
            
            const startRecording = (retryCount = 0) => {
                console.log(`🔄 Attempting to start recording (attempt ${retryCount + 1})...`);
                
                chrome.tabs.sendMessage(recorderTab.id, { 
                    action: "startRecording", 
                    tabId: tabId,
                    autoRecord: true,
                    service: service
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.log(`❌ Recorder tab not ready (attempt ${retryCount + 1}/3), retrying...`);
                        if (retryCount < 2) {
                            setTimeout(() => startRecording(retryCount + 1), 1000);
                        } else {
                            console.error("❌ Failed to start recording after 3 attempts");
                            chrome.tabs.remove(recorderTab.id);

                            if (service === 'gmeet' || service === 'teams' || service === 'zoom') {
                                handlePermissionRecovery(tabId, service);
                            }
                        }
                    } else {
                        console.log("✅ Recording started successfully");

currentRecordingTab = tabId;
isAutoRecording = true;

console.log("✅ Active recording tab updated:", currentRecordingTab);
                    }
                });
            };
            
            setTimeout(() => startRecording(), 1500);
        });
    }

    function stopAllRecordings() {
        console.log("🛑 Stopping all recordings");
        
        chrome.tabs.query({ url: chrome.runtime.getURL("recorder.html") }, (tabs) => {
            if (tabs.length > 0) {
                console.log(`🛑 Stopping ${tabs.length} recorder tab(s)`);
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { action: "stopRecording" });
                });
            } else {
                console.log("⚠️ No recorder tabs found");
            }
            setTimeout(() => {
    closeRecorderTab();
}, 3000);
        });
        
        currentRecordingTab = null;
        isAutoRecording = false;
        
        chrome.storage.local.remove(['isRecording', 'recordingTime', 'recordingStartTime', 'recordingTabId']);
    }

    // Monitor tab closures
   chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {

    // MEETING TAB CLOSED
    if (tabId === currentRecordingTab) {

        console.log("❌ Meeting tab closed/leaved");
        console.log("🛑 Stopping recorder automatically");

        // Find recorder tabs
        chrome.tabs.query({
            url: chrome.runtime.getURL("recorder.html")
        }, (tabs) => {

            if (tabs.length === 0) {
                console.log("⚠️ No recorder tabs found");
                return;
            }

            tabs.forEach((tab) => {

                console.log("📨 Sending stopRecording to recorder tab:", tab.id);

                chrome.tabs.sendMessage(tab.id, {
                    action: "stopRecording",
                    forceAutoDownload: true
                }, (response) => {

                    if (chrome.runtime.lastError) {
                        console.log("❌ Could not stop recorder:", chrome.runtime.lastError.message);
                    } else {
                        console.log("✅ Recorder stop message sent");
                    }
                });
            });
        });

        currentRecordingTab = null;
        isAutoRecording = false;
    }

    // RECORDER TAB CLOSED
    chrome.tabs.get(tabId, (tab) => {

        if (chrome.runtime.lastError) {
            return;
        }

        if (tab && tab.url && tab.url.includes("recorder.html")) {

            console.log("🛑 Recorder tab closed");

            chrome.storage.local.remove([
                'isRecording',
                'recordingTime',
                'recordingStartTime',
                'recordingTabId'
            ]);

            currentRecordingTab = null;
            isAutoRecording = false;
        }
    });
});

    // ==================== MESSAGE HANDLER ====================
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log("📨 Background received:", message.action);
        
        const handleAsync = async () => {
            try {
                // Huddle download messages
                if (message.action === "downloadRecording") {
                    await handleDirectDownload(message.data, message.filename);
                    return { success: true };
                }

                if (message.action === "manualStopRecording") {
    console.log("🛑 Background: Manual stop recording");

    stopRecording();

    sendResponse({ success: true });

    return true;
}

                if (message.action === "downloadBlob") {
                    const blob = new Blob([new Uint8Array(message.data)], { type: message.mimeType });
                    const blobUrl = URL.createObjectURL(blob);
                    
                    chrome.downloads.download({
                        url: blobUrl,
                        filename: message.filename,
                        saveAs: false,
                        conflictAction: 'uniquify'
                    }, (downloadId) => {
                        if (chrome.runtime.lastError) {
                            sendResponse({ success: false, error: chrome.runtime.lastError });
                        } else {
                            sendResponse({ success: true, downloadId: downloadId });
                        }
                        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
                    });
                    return true;
                }

                // Common permission messages
                if (message.action === "grantAutoRecordPermission") {
                    const result = await chrome.storage.local.get(['autoRecordPermissions']);
                    const permissions = result.autoRecordPermissions || {};
                    permissions[message.service] = true;
                    await chrome.storage.local.set({ autoRecordPermissions: permissions });

                    userPermissionGranted = true;
    
                    if (message.service === 'gmeet') {
                        notifyAllGmeetTabs(true);
                    } else if (message.service === 'teams') {
                        notifyAllTeamsTabs(true);
                    } else if (message.service === 'zoom') {
                        notifyAllZoomTabs(true);
                    } else if (message.service === 'gchat') {
                        notifyAllGchatTabs(true);
                    }

                    console.log(`✅ Auto record permission granted for ${message.service}`);
                    return { success: true };
                }

                if (message.action === "revokeAutoRecordPermission") {
                    // BLOCK revoking for gchat
                    if (message.service === 'gchat') {
                        console.log("🔒 Cannot revoke GChat auto-record permission - always enabled");
                        sendResponse({ success: false, reason: "gchat_always_enabled" });
                        return true;
                    }

                    const result = await chrome.storage.local.get(['autoRecordPermissions']);
                    const permissions = result.autoRecordPermissions || {};
                    permissions[message.service] = false;
                    await chrome.storage.local.set({ autoRecordPermissions: permissions });

                    userPermissionGranted = false;
    
                    if (message.service === 'gmeet') {
                        notifyAllGmeetTabs(false);
                    } else if (message.service === 'teams') {
                        notifyAllTeamsTabs(false);
                    } else if (message.service === 'zoom') {
                        notifyAllZoomTabs(false);
                    } else if (message.service === 'gchat') {
                        notifyAllGchatTabs(false);
                    }
                    console.log(`❌ Auto record permission revoked for ${message.service}`);
                    return { success: true };
                }

                if (message.action === "autoRecordToggledOn") {
                    console.log(`🔄 Auto-record toggled ON for ${message.service}, checking current meeting...`);
    
                    let urlPatterns = [];
                    if (message.service === 'gmeet') {
                        urlPatterns = ["https://*.meet.google.com/*"];
                    } else if (message.service === 'teams') {
                        urlPatterns = ["https://*.teams.microsoft.com/*", "https://*.teams.live.com/*"];
                    } else if (message.service === 'zoom') {
                        urlPatterns = ["https://*.zoom.us/*", "https://*.zoom.com/*"];
                    } else if (message.service === 'gchat') {
                        urlPatterns = ["https://chat.google.com/*", "https://mail.google.com/*"];
                    }
    
                    chrome.tabs.query({ url: urlPatterns }, (tabs) => {
                        tabs.forEach(tab => {
                            chrome.tabs.sendMessage(tab.id, {
                                action: "autoRecordToggledOn",
                                enabled: true
                            }, (response) => {
                                if (chrome.runtime.lastError) {
                                    console.log("⚠️ Could not notify tab:", tab.id);
                                }
                            });
                        });
                    });
    
                    return { success: true };
                }

                // Service-specific auto start
                if (message.action === "autoStartRecording") {
                    const service = detectService(sender.tab?.url);
                    if (service === 'gmeet') {
                        return await handleGmeetAutoStart(message, sender);
                    } else if (service === 'teams') {
                        return handleTeamsAutoStart(sender);
                    } else if (service === 'zoom') { 
                        return handleZoomAutoStart(sender);
                    } else if (service === 'gchat') {
                        startRecordingForTab(sender.tab.id, 'gchat');
                        return { success: true };
                    }
                }

                if (message.action === "manualStartRecording") {
                    console.log("🎬 Manual recording requested for tab:", message.tabId, "service:", message.service);
                    startRecordingForTab(message.tabId, message.service);
                    return { success: true };
                }

                if (message.action === "manualStopRecording") {
                    console.log("🛑 Manual stop requested");
                    stopAllRecordings();
                    return { success: true };
                }

                // Common stop messages
                if (message.action === "autoStopRecording") {

    console.log("🛑 Auto stop recording requested");

    // Skip stop only during active Huddle → Meet transition
    if (isExtendingToMeet) {

        const transitionAge = Date.now() - extendTransitionTime;

        if (transitionAge < 10000) {

            console.log("⏳ Transition active - delaying stop");

            return { success: true };
        }

        isExtendingToMeet = false;
    }

    console.log("🛑 FINAL STOP EXECUTING");

    stopAllRecordings();

    return { success: true };
}

                if (message.action === "recordingCompleted") {
                    currentRecordingTab = null;
                    isAutoRecording = false;
                    
                    chrome.tabs.query({ url: ["https://*.meet.google.com/*", "https://*.teams.microsoft.com/*", "https://*.teams.live.com/*", "https://*.zoom.us/*", "https://*.zoom.com/*", "https://chat.google.com/*", "https://mail.google.com/*"] }, (tabs) => {
                        tabs.forEach(tab => {
                            chrome.tabs.sendMessage(tab.id, { action: "recordingCompleted" });
                        });
                    });

                    setTimeout(() => {
                        closeAllRecorderTabs();
                    }, 1000);

                    return { success: true };
                }
                
                if (message.action === "checkMeetingStatus") {
                    chrome.tabs.sendMessage(sender.tab.id, { action: "checkMeetingStatus" }, (response) => {
                        sendResponse(response);
                    });
                    return true;
                }

                if (message.action === "closeRecorderTab") {
                    console.log("🛑 Closing recorder tab for auto mode");
                    closeAllRecorderTabs();
                    return { success: true };
                }

                if (message.action === "stopRecordingOnMeetingEnd") {
                    console.log("🛑 Meeting ended - AUTO-DOWNLOADING recording");
                    await stopRecordingOnMeetingEnd();
                    return { success: true };
                }

                if (message.action === "showMeetStatus" || message.action === "updateMeetTimer") {
                    chrome.tabs.query({ url: "https://*.meet.google.com/*" }, (tabs) => {
                        tabs.forEach(tab => {
                            chrome.tabs.sendMessage(tab.id, message, (response) => {
                                if (chrome.runtime.lastError) {
                                    console.log("⚠️ Could not send to Meet tab:", tab.id);
                                }
                            });
                        });
                    });
                    return { success: true };
                }

                if (message.action === "showTeamsStatus" || message.action === "updateTeamsTimer") {
                    chrome.tabs.query({ url: ["https://*.teams.microsoft.com/*", "https://*.teams.live.com/*"] }, (tabs) => {
                        tabs.forEach(tab => {
                            chrome.tabs.sendMessage(tab.id, message, (response) => {
                                if (chrome.runtime.lastError) {
                                    console.log("⚠️ Could not send to Teams tab:", tab.id);
                                }
                            });
                        });
                    });
                    return { success: true };
                }

                if (message.action === "zoomMuteChanged") {
                    console.log("🔇 ZOOM MUTE STATE RECEIVED →", message.muted ? "MUTED" : "UNMUTED");
                    
                    chrome.tabs.query({ url: chrome.runtime.getURL("recorder.html") }, (tabs) => {
                        console.log(`🔇 Forwarding mute to ${tabs.length} recorder tab(s)`);
                        
                        tabs.forEach(tab => {
                            chrome.tabs.sendMessage(tab.id, {
                                action: "zoomMuteChanged",
                                muted: message.muted
                            }).catch(err => {
                                console.log("⚠️ Could not forward mute to recorder:", err);
                            });
                        });
                    });
                    
                    sendResponse({ success: true });
                }

                if (message.action === "showZoomStatus" || message.action === "updateZoomTimer") {
                    chrome.tabs.query({ url: ["https://*.zoom.us/*", "https://*.zoom.com/*"] }, (tabs) => {
                        tabs.forEach(tab => {
                            chrome.tabs.sendMessage(tab.id, message, (response) => {
                                if (chrome.runtime.lastError) {
                                    console.log("⚠️ Could not send to Zoom tab:", tab.id);
                                }
                            });
                        });
                    });
                    return { success: true };
                }

                if (message.action === "recordingStarted") {
                    const timestamp = new Date().toLocaleTimeString();
                    console.log(`✅ Recording started successfully at ${timestamp}`);
                    currentRecordingTab = sender.tab.id;
                    
                    await chrome.storage.local.set({ 
                        isRecording: true,
                        recordingStartTime: Date.now(),
                        recordingTabId: sender.tab.id
                    });
                    
                    return { success: true };
                }

                if (message.action === "recordingStopped") {
                    const timestamp = new Date().toLocaleTimeString();
                    console.log(`✅ Recording stopped successfully at ${timestamp}`);
                    currentRecordingTab = null;
                    
                    await chrome.storage.local.remove(['isRecording', 'recordingTime', 'recordingStartTime', 'recordingTabId']);
                    
                    return { success: true };
                }

                if (message.action === "timerUpdate") {
                    await chrome.storage.local.set({ recordingTime: message.time });
                    return { success: true };
                }

                return { success: false, reason: "unknown_action" };
            } catch (error) {
                console.error("❌ Error handling message:", error);
                return { success: false, error: error.message };
            }
        };

        handleAsync().then(sendResponse);
        return true;
    });

    async function handleDirectDownload(data, filename) {
        try {
            console.log("💾 Downloading to Downloads folder:", filename);
            
            if (data && data.type === 'blob' && data.data) {
                const binaryString = atob(data.data);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                const blob = new Blob([bytes], { type: data.mimeType || 'video/webm' });
                const blobUrl = URL.createObjectURL(blob);
                
                chrome.downloads.download({
                    url: blobUrl,
                    filename: filename,
                    saveAs: false,
                    conflictAction: 'uniquify'
                }, (downloadId) => {
                    if (chrome.runtime.lastError) {
                        console.error("Download error:", chrome.runtime.lastError);
                    } else {
                        console.log("✅ Download started with ID:", downloadId);
                    }
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
                });
            } else if (typeof data === 'string') {
                chrome.downloads.download({
                    url: data,
                    filename: filename,
                    saveAs: false,
                    conflictAction: 'uniquify'
                }, (downloadId) => {
                    if (chrome.runtime.lastError) {
                        console.error("Download error:", chrome.runtime.lastError);
                    } else {
                        console.log("✅ Download started with ID:", downloadId);
                    }
                });
            } else {
                console.error("No valid data provided for download");
            }
        } catch (error) {
            console.error("Failed to download:", error);
        }
    }

    // Handle extension installation
    chrome.runtime.onInstalled.addListener((details) => {
        console.log("🔧 Extension installed/updated:", details.reason);
        restoreAutoRecordState();
    
        if (details.reason === 'install') {
            chrome.storage.local.set({ autoRecordPermissions: {} });
            console.log("🔐 Auto recording disabled by default for all services");
        }
    });

    // Keep service worker alive
    setInterval(() => {
        chrome.runtime.getPlatformInfo(() => {});
    }, 20000);

  function closeRecorderTab() {

    chrome.tabs.query({}, (tabs) => {

        tabs.forEach((tab) => {

            if (
                tab.url &&
                tab.url.includes(chrome.runtime.id) &&
                tab.url.includes('recorder.html')
            ) {

                console.log("🗑️ Closing recorder tab:", tab.id);

                chrome.tabs.remove(tab.id);
            }
        });
    });
}

    // Clean up stale extend flags after 30 seconds
    setInterval(() => {
        chrome.storage.local.get(['isExtendingToMeet', 'extendTransitionTime'], (result) => {
            if (result.isExtendingToMeet && result.extendTransitionTime) {
                const timeSinceExtend = Date.now() - result.extendTransitionTime;
                if (timeSinceExtend > 30000) {
                    console.log("🧹 Cleaning up stale extend flag");
                    chrome.storage.local.remove(['isExtendingToMeet', 'extendTransitionTime']);
                }
            }
        });
    }, 10000);

    console.log("🔧 Unified Background script loaded successfully");
})();
