document.addEventListener('DOMContentLoaded', async function() {
  const videoInfo = document.getElementById('video-info');
  const titleEl = document.getElementById('title');
  const durationEl = document.getElementById('duration');
  const statusEl = document.getElementById('status');
  const downloadBtn = document.getElementById('download');

  // Get current tab URL
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!tab.url.includes('ruv.is')) {
    updateStatus('⚠️ Please navigate to a RÚV video page', 'error');
    downloadBtn.disabled = true;
    return;
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'downloadError') {
      updateStatus(`❌ ${message.error}`, 'error');
      downloadBtn.disabled = false;
      downloadBtn.classList.remove('downloading');
    }
    else if (message.action === 'downloadProgress') {
      updateStatus(`⏬ Downloading: ${message.progress}%`, 'progress');
    }
    else if (message.action === 'downloadComplete') {
      updateStatus(`✅ Download complete!\nCheck folder: ${message.folderName}`, 'success');
      downloadBtn.disabled = false;
      downloadBtn.classList.remove('downloading');
    }
  });

  function updateStatus(message, type = 'info') {
    statusEl.textContent = message;
    statusEl.className = type ? `status-${type}` : '';
  }

  // Set initial loading state
  downloadBtn.disabled = true;
  if (durationEl?.querySelector('.text')) {
    durationEl.querySelector('.text').textContent = 'Loading video information...';
  }

  try {
    // Extract video information from the page
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        try {
          console.log('🔍 Starting video info extraction...');

          // Helper function to wait for element
          function waitForElement(selector, maxWait = 5000) {
            return new Promise((resolve) => {
              if (document.querySelector(selector)) {
                return resolve(document.querySelector(selector));
              }

              const observer = new MutationObserver(() => {
                if (document.querySelector(selector)) {
                  observer.disconnect();
                  resolve(document.querySelector(selector));
                }
              });

              observer.observe(document.body, {
                childList: true,
                subtree: true
              });

              // Timeout after maxWait
              setTimeout(() => {
                observer.disconnect();
                resolve(null);
              }, maxWait);
            });
          }

          // Function to get video info
          async function getVideoInfo() {
            // Try to get data from page source first
            const pageSource = document.documentElement.outerHTML;
            const fileMatch = pageSource.match(/file:\s*["']([^"']+\.m3u8)["']/i) ||
                            pageSource.match(/["']file["']\s*:\s*["']([^"']+\.m3u8)["']/i);
            
            if (fileMatch?.[1]) {
              return {
                title: document.title.replace(' - RÚV', '').trim(),
                manifestUrl: fileMatch[1],
                success: true
              };
            }

            // Try to get data from URL
            const urlMatch = window.location.pathname.match(/\/spila\/([^\/]+)\/\d+\/([a-zA-Z0-9]+)/);
            if (urlMatch) {
              const [, showName, videoId] = urlMatch;
              
              // Try RÚV's API
              try {
                const apiResponse = await fetch(`https://www.ruv.is/api/programs/${videoId}`, {
                  headers: {
                    'Accept': 'application/json',
                    'Origin': 'https://www.ruv.is',
                    'Referer': window.location.href
                  }
                });
                
                if (apiResponse.ok) {
                  const data = await apiResponse.json();
                  if (data.file) {
                    return {
                      title: data.title || document.title.replace(' - RÚV', '').trim(),
                      manifestUrl: data.file,
                      success: true
                    };
                  }
                }
              } catch (e) {
                console.error('API error:', e);
              }

              // Fallback to constructed URL
              return {
                title: decodeURIComponent(showName).replace(/-/g, ' ')
                  .replace(/\b\w/g, l.toUpperCase()),
                manifestUrl: `https://ruv-vod.akamaized.net/${videoId}/master.m3u8`,
                success: true
              };
            }

            return { success: false };
          }

          // Wait for the page to be ready
          await waitForElement('.video-player, .episode-header, [class*="PlayerHeader"]');
          
          // Get video info
          const videoInfo = await getVideoInfo();
          console.log('Video info:', videoInfo);
          
          if (!videoInfo.success) {
            throw new Error('Could not find video information');
          }

          return videoInfo;
        } catch (e) {
          console.error('Script error:', e);
          return { success: false, error: e.message };
        }
      }
    });

    console.log('Script execution result:', result);
    
    if (!result?.[0]?.result?.success) {
      throw new Error(result?.[0]?.result?.error || 'Failed to extract video information');
    }

    const videoData = result[0].result;

    // Display video information with animation
    videoInfo.style.opacity = '0';
    setTimeout(() => {
      const titleSpan = titleEl.querySelector('.text');
      const durationSpan = durationEl.querySelector('.text');
      
      if (titleSpan && videoData.title) {
        titleSpan.textContent = videoData.title;
      }
      
      if (durationSpan) {
        durationSpan.textContent = 'Ready to download!';
      }
      
      videoInfo.style.opacity = '1';
      downloadBtn.disabled = false; // Only enable button after successful validation
    }, 300);
    
    // Handle download button click
    downloadBtn.addEventListener('click', async () => {
      const quality = document.getElementById('quality').value;
      updateStatus('⏳ Starting download...', 'progress');
      downloadBtn.disabled = true;
      downloadBtn.classList.add('downloading');
      
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'downloadVideo',
          videoData: videoData,
          quality: quality,
          title: videoData.title
        });

        if (!response || !response.success) {
          throw new Error(response?.error || 'Failed to start download');
        }
      } catch (error) {
        console.error('Download error:', error);
        updateStatus(`❌ ${error.message}`, 'error');
        downloadBtn.disabled = false;
        downloadBtn.classList.remove('downloading');
      }
    });
  } catch (error) {
    console.error('❌ Popup error:', error);
    updateStatus(`❌ ${error.message}`, 'error');
    downloadBtn.disabled = true;
    if (durationEl?.querySelector('.text')) {
      durationEl.querySelector('.text').textContent = 'Video information unavailable';
    }
  }
});