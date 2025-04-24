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

    // Headers for RÚV requests
    const headers = {
      'Origin': 'https://www.ruv.is',
      'Referer': 'https://www.ruv.is/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36'
    };

    let masterResponse = await fetch(videoData.manifestUrl, { headers });
    if (!masterResponse.ok) {
      throw new Error(`Failed to fetch master playlist: ${masterResponse.status}`);
    }

    const masterPlaylist = await masterResponse.text();
    const variantUrl = await getBestQualityVariant(masterPlaylist, baseUrl, quality);
    if (!variantUrl) {
      throw new Error('No suitable quality variant found');
    }

    console.log('Selected variant URL:', variantUrl);

    // Fetch the variant playlist
    const variantResponse = await fetch(variantUrl, { headers });
    if (!variantResponse.ok) {
      throw new Error(`Failed to fetch variant playlist: ${variantResponse.status}`);
    }

    const variantPlaylist = await variantResponse.text();
    const segments = parseM3U8Segments(variantPlaylist);
    console.log(`Found ${segments.length} segments`);

    // Create a clean filename
    const cleanTitle = (title || 'video').replace(/[/\\?%*:|"<>]/g, '-');
    
    // Calculate total duration
    const totalDuration = segments.reduce((acc, seg) => acc + seg.duration, 0);
    const totalMinutes = Math.round(totalDuration / 60);

    // Get the base URL for segment downloads
    const segmentBaseUrl = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);

    // Fetch all segments
    chrome.runtime.sendMessage({
      action: 'downloadProgress',
      progress: 0
    });

    const segmentData = [];
    let downloadedSize = 0;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segmentUrl = segmentBaseUrl + segment.uri;
      
      const response = await fetch(segmentUrl, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch segment ${i}: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      segmentData.push(buffer);
      downloadedSize += buffer.byteLength;

      // Update progress
      const progress = Math.round((i + 1) / segments.length * 100);
      chrome.runtime.sendMessage({
        action: 'downloadProgress',
        progress: progress
      });
    }

    // Concatenate all segments
    const concatenated = new Blob(segmentData, { type: 'video/mp2t' });
    const url = URL.createObjectURL(concatenated);

    // Download the concatenated file
    await chrome.downloads.download({
      url: url,
      filename: `${cleanTitle}.ts`,
      saveAs: true
    });

    // Cleanup
    URL.revokeObjectURL(url);

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
    // Extract the file ID if present
    const fileMatch = originalUrl.match(/ruv-vod\.akamaized\.net\/([^\/]+)/);
    if (fileMatch) {
      const fileId = fileMatch[1];
      // Try different quality variations
      const qualities = ['1200', '2400', '3600'];
      return `https://ruv-vod.akamaized.net/${fileId}/${qualities[2]}/index.m3u8`;
    }
  } catch (e) {
    console.error('Error generating alternative URL:', e);
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