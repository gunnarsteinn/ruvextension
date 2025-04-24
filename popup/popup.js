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

        // Try to get data from __INITIAL_STATE__ first
        function getInitialState() {
          const scripts = document.querySelectorAll('script:not([src])');
          for (const script of scripts) {
            const content = script.textContent;
            if (content.includes('__INITIAL_STATE__')) {
              try {
                const stateMatch = content.match(/__INITIAL_STATE__\s*=\s*({[^;]+})/);
                if (stateMatch) {
                  const state = JSON.parse(stateMatch[1]);
                  if (state.episode?.title || state.program?.title) {
                    return {
                      title: state.episode?.title || state.program?.title,
                      manifestUrl: state.episode?.file || state.program?.file
                    };
                  }
                }
              } catch (e) {
                console.error('Failed to parse __INITIAL_STATE__:', e);
              }
            }
          }
          return null;
        }

        // Wait for page to be fully loaded
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Function to try to auto-accept cookie consent
        async function handleCookieConsent() {
          const consentButton = document.querySelector(
            '[aria-label="Samþykkja allt"], ' + // Accept all in Icelandic
            'button:not([aria-label]):not([type])[class*="consent" i], ' + // Generic consent buttons
            'button[class*="accept" i][class*="all" i]' // Accept all variations
          );
          
          if (consentButton) {
            consentButton.click();
            // Wait for consent overlay to disappear
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        // Try to handle cookie consent first
        await handleCookieConsent();

        function findVideoInfo() {
          console.log('Starting findVideoInfo()...');
          
          // Try to get data from __INITIAL_STATE__ first
          const stateData = getInitialState();
          if (stateData?.title && stateData?.manifestUrl) {
            console.log('Found data in __INITIAL_STATE__:', stateData);
            return {
              title: stateData.title,
              manifestUrl: stateData.manifestUrl,
              success: true,
              source: 'initial_state'
            };
          }

          // Enhanced manifest URL extraction
          function findManifestUrl() {
            const scripts = document.querySelectorAll('script:not([src])');
            
            // First try to extract from URL for KrakkaRÚV
            const krakkaMatch = window.location.pathname.match(/\/krakkaruv\/spila\/[^/]+\/\d+\/([a-zA-Z0-9]+)/);
            if (krakkaMatch && krakkaMatch[1]) {
              console.log('Found KrakkaRÚV video ID:', krakkaMatch[1]);
              return `https://ruv-vod.akamaized.net/krakkaruv/${krakkaMatch[1]}/master.m3u8`;
            }

            // Enhanced manifest URL patterns
            const manifestPatterns = [
              /ruv-vod\.akamaized\.net\/([^/"']+)/i,
              /vod\.ruv\.is\/([^/"']+)/i,
              /"file":\s*"([^"]+\.m3u8)"/i,
              /'file':\s*'([^']+\.m3u8)'/i,
              /file:\s*["']([^"']+\.m3u8)["']/i,
              // Video ID patterns
              /"id":\s*"([^"]+)"/i,
              /'id':\s*'([^']+)'/i,
              /videoId:\s*["']([^"']+)["']/i,
              /video_id:\s*["']([^"']+)["']/i
            ];

            // Try to find complete manifest URLs
            for (const script of scripts) {
              const content = script.textContent;
              console.log('Analyzing script content for manifest URL...');
              
              for (const pattern of manifestPatterns.slice(0, 5)) {
                const match = content.match(pattern);
                if (match && match[1]) {
                  console.log('Found manifest URL pattern match:', match[1]);
                  if (match[1].includes('m3u8')) {
                    return match[1];
                  }
                }
              }

              // Then try to find video ID patterns
              for (const pattern of manifestPatterns.slice(5)) {
                const match = content.match(pattern);
                if (match && match[1] && match[1].length > 4) {
                  console.log('Found video ID:', match[1]);
                  // Check if we're on KrakkaRÚV
                  if (window.location.pathname.includes('/krakkaruv/')) {
                    return `https://ruv-vod.akamaized.net/krakkaruv/${match[1]}/master.m3u8`;
                  }
                  return `https://ruv-vod.akamaized.net/${match[1]}/master.m3u8`;
                }
              }
            }

            // Try to find URL in video element as fallback
            const videoElement = document.querySelector('video source[src*=".m3u8"], video[src*=".m3u8"]');
            if (videoElement) {
              const url = videoElement.src || videoElement.getAttribute('src');
              console.log('Found manifest URL in video element:', url);
              return url;
            }

            // Try to extract from regular URL as last resort
            const urlMatch = window.location.pathname.match(/\/spila\/[^/]+\/\d+\/([a-zA-Z0-9]+)/);
            if (urlMatch && urlMatch[1]) {
              console.log('Extracted video ID from URL:', urlMatch[1]);
              return `https://ruv-vod.akamaized.net/${urlMatch[1]}/master.m3u8`;
            }

            return null;
          }

          // Extract title from URL if it contains /spila/
          const urlMatch = window.location.pathname.match(/\/spila\/([^/]+)/);
          let urlTitle = urlMatch ? urlMatch[1] : null;
          if (urlTitle) {
            // Convert URL-friendly format back to readable title
            urlTitle = decodeURIComponent(urlTitle)
              .replace(/-/g, ' ')
              .replace(/\b\w/g, l => l.toUpperCase()); // Capitalize first letter of each word
          }

          // Enhanced RÚV selectors with more specific targeting
          const ruvSelectors = [
            // Primary title selectors for the new RÚV player
            '[class*="PlayerHeader_title"]',
            '[class*="PlayerInfo_title"]',
            // Program and episode specific selectors
            '[class*="ProgramHeader_title"]',
            '[class*="EpisodeHeader_title"]',
            // Original selectors
            '.episode-header h1',
            '.video-player-header h1',
            '.video-details h1',
            'main article h1',
            '[class*="Title_title"]',
            '[class*="VideoHeader_title"]',
            '[class*="EpisodeInfo_title"]',
            '[data-testid="episode-title"]',
            '[data-testid="program-title"]',
            // Additional backup selectors
            '.program-info h1',
            '.program-info .title',
            '.episode-info h1',
            '.episode-info .title',
            'h1[class*="title" i]'
          ];

          let videoData = {
            title: null,
            manifestUrl: null,
            programTitle: null,
            episodeTitle: null,
            date: null
          };

          // First try to find title in the page content
          for (const selector of ruvSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              const text = element.textContent.trim();
              if (text && 
                  !text.match(/^\d+$/) && 
                  !text.toLowerCase().includes('vafrakökur') &&
                  text.length > 3) {
                videoData.title = text;
                break;
              }
            }
          }

          // If no title found in page content, use the URL title
          if (!videoData.title && urlTitle) {
            videoData.title = urlTitle;
          }

          // Get manifest URL with enhanced extraction
          videoData.manifestUrl = findManifestUrl();
          console.log('Final manifest URL:', videoData.manifestUrl);

          // Only use technical ID as absolute last resort
          if (!videoData.title && videoData.manifestUrl) {
            const manifestId = videoData.manifestUrl.split('/')[3];
            videoData.title = urlTitle || `RÚV Video ${manifestId}`;
          }

          return {
            title: videoData.title,
            manifestUrl: videoData.manifestUrl,
            success: !!(videoData.title && videoData.manifestUrl),
            source: 'optimized'
          };
        }

        // Wait for content and try to get info
        await waitForElement(
          '.episode-header, .video-player, .video-details, main article, [class*="Title_title"]'
        );
        const videoInfo = findVideoInfo();
        
        // Validate manifest URL
        if (videoInfo.manifestUrl) {
          try {
            const testResponse = await fetch(videoInfo.manifestUrl, {
              method: 'HEAD',
              headers: {
                'Origin': 'https://www.ruv.is',
                'Referer': 'https://www.ruv.is/',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36'
              }
            });
            if (!testResponse.ok) {
              console.error('Invalid manifest URL:', videoInfo.manifestUrl);
              videoInfo.manifestUrl = null;
              videoInfo.success = false;
            }
          } catch (e) {
            console.error('Error validating manifest URL:', e);
            videoInfo.manifestUrl = null;
            videoInfo.success = false;
          }
        }
        
        return videoInfo;
      }
    });

    console.log('Script execution result:', result);
    const videoData = result[0].result;
    
    if (!videoData.success) {
      throw new Error('Failed to extract video information');
    }

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