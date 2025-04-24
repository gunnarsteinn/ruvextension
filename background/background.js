chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'downloadVideo') {
    // Keep message channel open
    handleVideoDownload(request)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('Download error:', error);
        chrome.runtime.sendMessage({
          action: 'downloadError',
          error: error.message
        });
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep the message channel open
  }
  return true;
});

async function handleVideoDownload({ videoData, quality, title }) {
  try {
    console.log('Starting download with video data:', videoData);
    
    if (!videoData.manifestUrl) {
      throw new Error('No manifest URL found');
    }

    // Get the base URL for segment downloads
    const baseUrl = videoData.manifestUrl.substring(0, videoData.manifestUrl.lastIndexOf('/') + 1);
    console.log('Base URL:', baseUrl);

    // Headers required for RÚV's CDN
    const headers = {
      'Origin': 'https://www.ruv.is',
      'Referer': 'https://www.ruv.is/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9,is;q=0.8',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'Connection': 'keep-alive'
    };

    // Try to fetch the master playlist
    let masterResponse = await fetch(videoData.manifestUrl, { 
      headers,
      credentials: 'omit'
    });

    // If original URL fails, try quality variants
    if (!masterResponse.ok) {
      console.log('Original manifest URL failed, trying quality variants...');
      const videoId = videoData.manifestUrl.match(/\/([^\/]+)\/[^\/]+\.m3u8$/)?.[1];
      
      if (videoId) {
        // Try to get stream URL from API first
        try {
          const apiResponse = await fetch(`https://www.ruv.is/api/programs/${videoId}`, {
            headers: {
              'Accept': 'application/json',
              'Origin': 'https://www.ruv.is',
              'Referer': 'https://www.ruv.is/'
            }
          });
          
          if (apiResponse.ok) {
            const data = await apiResponse.json();
            if (data.file) {
              masterResponse = await fetch(data.file, { headers, credentials: 'omit' });
              if (masterResponse.ok) {
                videoData.manifestUrl = data.file;
              }
            }
          }
        } catch (e) {
          console.error('Error fetching from API:', e);
        }

        // If API fails, try quality variants
        if (!masterResponse.ok) {
          const qualityMap = {
            'HD1080': '3600',
            'HD720': '2400',
            'Normal': '1200'
          };

          // Try the requested quality first
          const preferredQuality = qualityMap[quality] || '3600';
          const qualityVariants = [
            `https://ruv-vod.akamaized.net/${videoId}/${preferredQuality}/master.m3u8`,
            ...Object.values(qualityMap)
              .filter(q => q !== preferredQuality)
              .map(q => `https://ruv-vod.akamaized.net/${videoId}/${q}/master.m3u8`)
          ];

          for (const variantUrl of qualityVariants) {
            console.log('Trying quality variant:', variantUrl);
            try {
              masterResponse = await fetch(variantUrl, { 
                headers,
                credentials: 'omit'
              });
              
              if (masterResponse.ok) {
                console.log('Found working quality variant:', variantUrl);
                videoData.manifestUrl = variantUrl;
                break;
              }
            } catch (e) {
              console.log('Failed to fetch variant:', variantUrl, e);
            }
          }
        }
      }

      if (!masterResponse.ok) {
        throw new Error(`Failed to fetch master playlist: ${masterResponse.status}`);
      }
    }

    const masterPlaylist = await masterResponse.text();
    const variantUrl = await getBestQualityVariant(masterPlaylist, baseUrl, quality);
    if (!variantUrl) {
      throw new Error('No suitable quality variant found');
    }

    console.log('Selected variant URL:', variantUrl);

    // Fetch the variant playlist
    const variantResponse = await fetch(variantUrl, { headers, credentials: 'omit' });
    if (!variantResponse.ok) {
      throw new Error(`Failed to fetch variant playlist: ${variantResponse.status}`);
    }

    const variantPlaylist = await variantResponse.text();
    const segments = parseM3U8Segments(variantPlaylist);
    console.log(`Found ${segments.length} segments`);

    // Create a clean filename
    const cleanTitle = (title || 'video').replace(/[/\\?%*:|"<>]/g, '-');
    
    // Get the base URL for segment downloads
    const segmentBaseUrl = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);

    // Create a shared buffer to store all segment data
    let totalSize = 0;
    const segmentData = [];

    // Download all segments
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segmentUrl = segmentBaseUrl + segment.uri;
      
      const response = await fetch(segmentUrl, { headers, credentials: 'omit' });
      if (!response.ok) {
        throw new Error(`Failed to fetch segment ${i}: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      segmentData.push(new Uint8Array(buffer));
      totalSize += buffer.byteLength;

      // Update progress
      const progress = Math.round((i + 1) / segments.length * 100);
      chrome.runtime.sendMessage({
        action: 'downloadProgress',
        progress: progress
      });
    }

    // Create the final buffer and combine all segments
    const finalBuffer = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of segmentData) {
      finalBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Create a new blob with all data
    const blob = new Blob([finalBuffer], { type: 'video/mp2t' });
    console.log('Final blob size:', blob.size);

    // Create a download URL and trigger download
    const downloadUrl = URL.createObjectURL(blob);

    await chrome.downloads.download({
      url: downloadUrl,
      filename: `${cleanTitle}.ts`,
      saveAs: true
    });

    // Clean up the URL
    URL.revokeObjectURL(downloadUrl);

    // Send completion message
    chrome.runtime.sendMessage({
      action: 'downloadComplete',
      folderName: cleanTitle
    });

  } catch (error) {
    console.error('Download error:', error);
    throw error;
  }
}

async function getAuthToken() {
  try {
    const response = await fetch('https://www.ruv.is/api/auth/ruvid/token', {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://www.ruv.is',
        'Referer': 'https://www.ruv.is/'
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      return data.token;
    }
  } catch (e) {
    console.error('Error getting auth token:', e);
  }
  return '';
}

function parseM3U8Segments(playlist) {
  const lines = playlist.split('\n');
  const segments = [];
  let currentDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.startsWith('#EXTINF:')) {
      // Parse duration
      const duration = parseFloat(line.split(':')[1]);
      // Get the next line which should be the segment URI
      const uri = lines[i + 1]?.trim();
      
      if (uri && !uri.startsWith('#')) {
        segments.push({
          duration: duration,
          uri: uri
        });
        i++; // Skip the next line since we already processed it
      }
    }
  }

  return segments;
}

async function getBestQualityVariant(masterPlaylist, baseUrl, preferredQuality) {
  const lines = masterPlaylist.split('\n');
  const variants = [];
  let currentBandwidth = null;

  const qualityPreferences = {
    'Normal': 1200000,
    'HD720': 2400000,
    'HD1080': 3600000
  };

  const targetBandwidth = qualityPreferences[preferredQuality];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
      if (bandwidthMatch) {
        currentBandwidth = parseInt(bandwidthMatch[1]);
      }
    } else if (line && !line.startsWith('#')) {
      if (currentBandwidth !== null) {
        const variantUrl = line.startsWith('http') ? line : baseUrl + line;
        variants.push({
          bandwidth: currentBandwidth,
          url: variantUrl
        });
        currentBandwidth = null;
      }
    }
  }

  // If no variants found, return the original URL
  if (variants.length === 0) {
    return baseUrl + 'index.m3u8';
  }

  // Find the variant closest to target bandwidth
  variants.sort((a, b) => 
    Math.abs(targetBandwidth - a.bandwidth) - Math.abs(targetBandwidth - b.bandwidth)
  );

  return variants[0].url;
}

function getAlternativeManifestUrl(originalUrl) {
  try {
    // Extract video ID from various URL patterns
    let videoId;
    
    // Try to extract from full URL
    const patterns = [
      /ruv-vod\.akamaized\.net\/([^\/]+)/,
      /\/sjonvarp\/spila\/[^\/]+\/\d+\/([a-zA-Z0-9]+)/,
      /\/krakkaruv\/spila\/[^\/]+\/\d+\/([a-zA-Z0-9]+)/
    ];

    for (const pattern of patterns) {
      const match = originalUrl.match(pattern);
      if (match && match[1]) {
        videoId = match[1];
        break;
      }
    }

    if (videoId) {
      // Try different URL formats
      const urlFormats = [
        `https://ruv-vod.akamaized.net/${videoId}/master.m3u8`,
        `https://ruv-vod.akamaized.net/${videoId}/index.m3u8`,
        `https://ruv-vod.akamaized.net/${videoId}/3600/master.m3u8`,
        `https://ruv-vod.akamaized.net/${videoId}/3600/index.m3u8`,
        `https://ruv-vod.akamaized.net/${videoId}/2400/master.m3u8`,
        `https://ruv-vod.akamaized.net/${videoId}/2400/index.m3u8`,
        `https://ruv-vod.akamaized.net/${videoId}/1200/master.m3u8`,
        `https://ruv-vod.akamaized.net/${videoId}/1200/index.m3u8`
      ];

      // Return all possible URLs to try
      return urlFormats;
    }
  } catch (e) {
    console.error('Error generating alternative URLs:', e);
  }
  return null;
}

async function getHLSMediaUrl(manifest, baseUrl, quality) {
  const lines = manifest.split('\n');
  const basePath = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  
  // Quality preferences in bits per second
  const qualityPreferences = {
    'Normal': 1200000,
    'HD720': 2400000,
    'HD1080': 3600000
  };
  
  const targetBandwidth = qualityPreferences[quality];
  let bestUrl = null;
  let bestBandwidth = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
      if (bandwidthMatch) {
        const bandwidth = parseInt(bandwidthMatch[1]);
        const nextLine = lines[i + 1]?.trim();
        
        if (nextLine && !nextLine.startsWith('#')) {
          const streamUrl = nextLine.startsWith('http') ? nextLine : basePath + nextLine;
          
          if (!bestUrl || Math.abs(targetBandwidth - bandwidth) < Math.abs(targetBandwidth - bestBandwidth)) {
            bestUrl = streamUrl;
            bestBandwidth = bandwidth;
          }
        }
      }
    }
  }
  
  if (!bestUrl) {
    // Try to find any media URL as fallback
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.startsWith('#') && (line.endsWith('.ts') || line.endsWith('.mp4'))) {
        return line.startsWith('http') ? line : basePath + line;
      }
    }
  }
  
  if (bestUrl) {
    // If we found a variant playlist, fetch it to get the media URL
    const response = await fetch(bestUrl);
    if (response.ok) {
      const variantPlaylist = await response.text();
      // Get the first media segment URL
      const mediaUrl = variantPlaylist.split('\n').find(line => 
        line.trim() && !line.startsWith('#') && (line.endsWith('.ts') || line.endsWith('.mp4'))
      );
      
      if (mediaUrl) {
        return mediaUrl.startsWith('http') ? mediaUrl : bestUrl.substring(0, bestUrl.lastIndexOf('/') + 1) + mediaUrl;
      }
    }
  }
  
  return bestUrl;
}

async function getDASHMediaUrl(manifest, baseUrl, quality) {
  // Simple XML parsing
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(manifest, 'text/xml');
  
  // Get all adaptation sets
  const adaptationSets = xmlDoc.getElementsByTagName('AdaptationSet');
  let bestUrl = null;
  let bestBandwidth = 0;
  
  // Quality preferences in bits per second
  const qualityPreferences = {
    'Normal': 1200000,
    'HD720': 2400000,
    'HD1080': 3600000
  };
  
  const targetBandwidth = qualityPreferences[quality];
  
  for (const adaptationSet of adaptationSets) {
    // Look for video adaptation sets
    if (adaptationSet.getAttribute('mimeType')?.includes('video') ||
        adaptationSet.getAttribute('contentType') === 'video') {
      
      const representations = adaptationSet.getElementsByTagName('Representation');
      
      for (const representation of representations) {
        const bandwidth = parseInt(representation.getAttribute('bandwidth'));
        const baseURL = representation.getElementsByTagName('BaseURL')[0]?.textContent;
        
        if (baseURL) {
          const mediaUrl = baseURL.startsWith('http') ? baseURL : baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + baseURL;
          
          if (!bestUrl || Math.abs(targetBandwidth - bandwidth) < Math.abs(targetBandwidth - bestBandwidth)) {
            bestUrl = mediaUrl;
            bestBandwidth = bandwidth;
          }
        }
      }
    }
  }
  
  return bestUrl;
}