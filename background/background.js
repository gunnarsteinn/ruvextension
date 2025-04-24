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

    // Try different URL patterns if the original fails
    let masterResponse = await fetch(videoData.manifestUrl, {
      headers: headers
    });
    
    if (!masterResponse.ok) {
      console.log(`First attempt failed with status ${masterResponse.status}, trying alternative URLs...`);
      
      // Try alternative URL patterns
      const videoId = videoData.manifestUrl.split('/')[3];
      const alternativeUrls = [
        `https://ruv-vod.akamaized.net/${videoId}/master.m3u8`,
        `https://vod.ruv.is/${videoId}/master.m3u8`,
        `https://ruv-vod.akamaized.net/TV/${videoId}/master.m3u8`,
        `https://ruv-vod.akamaized.net/krakkaruv/${videoId}/master.m3u8`
      ];

      for (const url of alternativeUrls) {
        console.log('Trying alternative URL:', url);
        masterResponse = await fetch(url, {
          headers: headers
        });
        if (masterResponse.ok) {
          console.log('Successfully found working URL:', url);
          videoData.manifestUrl = url;
          break;
        }
      }

      if (!masterResponse.ok) {
        throw new Error(`Failed to fetch master playlist: ${masterResponse.status} (tried multiple URL patterns)`);
      }
    }

    const masterPlaylist = await masterResponse.text();
    console.log('Master playlist:', masterPlaylist);

    // Get the best quality variant URL
    const variantUrl = await getBestQualityVariant(masterPlaylist, baseUrl, quality);
    if (!variantUrl) {
      throw new Error('No suitable quality variant found');
    }

    console.log('Selected variant URL:', variantUrl);

    // Fetch the variant playlist
    const variantResponse = await fetch(variantUrl);
    if (!variantResponse.ok) {
      throw new Error(`Failed to fetch variant playlist: ${variantResponse.status}`);
    }

    const variantPlaylist = await variantResponse.text();
    console.log('Variant playlist:', variantPlaylist);

    // Parse segments
    const segments = parseM3U8Segments(variantPlaylist);
    console.log(`Found ${segments.length} segments`);

    // Create a clean filename
    const cleanTitle = (title || 'video').replace(/[/\\?%*:|"<>]/g, '-');
    
    // Calculate total duration
    const totalDuration = segments.reduce((acc, seg) => acc + seg.duration, 0);
    const totalMinutes = Math.round(totalDuration / 60);
    
    // Create downloads folder name with quality and duration
    const folderName = `${cleanTitle} (${quality} - ${totalMinutes}min)`;

    // Get the base URL for segment downloads
    const segmentBaseUrl = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);

    // Create batch downloads for segments
    const batchSize = 10; // Download 10 segments at a time
    const batches = [];
    
    for (let i = 0; i < segments.length; i += batchSize) {
      const batch = segments.slice(i, i + batchSize);
      batches.push(batch);
    }

    // Create README content
    const readmeText = [
      `This folder contains video segments from "${cleanTitle}"`,
      `Total duration: ${totalMinutes} minutes`,
      `Quality: ${quality}`,
      ``,
      `To combine the segments, you can use:`,
      `1. VLC Media Player: Add all .ts files to a playlist`,
      `2. ffmpeg command: ffmpeg -i "concat:segment*.ts" -c copy "${cleanTitle}.mp4"`
    ].join('\n');

    // Create data URL for README
    const readmeDataUrl = 'data:text/plain;base64,' + btoa(unescape(encodeURIComponent(readmeText)));

    // Download README file
    await chrome.downloads.download({
      url: readmeDataUrl,
      filename: `${folderName}/README.txt`,
      saveAs: false
    });

    // Download segments in batches
    console.log(`Starting download of ${batches.length} batches...`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      await Promise.all(batch.map((segment, index) => {
        const segmentUrl = segmentBaseUrl + segment.uri;
        const segmentIndex = i * batchSize + index;
        const paddedIndex = segmentIndex.toString().padStart(4, '0');
        
        return chrome.downloads.download({
          url: segmentUrl,
          filename: `${folderName}/segment${paddedIndex}.ts`,
          saveAs: false
        });
      }));

      // Update progress
      const progress = Math.round(((i + 1) * batchSize / segments.length) * 100);
      chrome.runtime.sendMessage({
        action: 'downloadProgress',
        progress: Math.min(progress, 100)
      });
    }

    // Send completion message
    chrome.runtime.sendMessage({
      action: 'downloadComplete',
      folderName: folderName
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