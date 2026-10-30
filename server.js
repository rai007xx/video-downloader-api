const express = require('express');
const cors = require('cors');
const youtubedl = require('yt-dlp-exec');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  jsonResponse(res, 200, {
    status: 'online',
    service: 'StreamSave API',
    version: '2.2.0',
    endpoints: {
      download: 'GET /api/download?url=YOUR_VIDEO_URL',
      proxy: 'GET /api/proxy?url=YOUR_VIDEO_URL&filename=file.ext'
    }
  });
});

// Video metadata & photo slideshow extraction endpoint
app.get('/api/download', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return jsonResponse(res, 400, {
      success: false,
      error: 'Missing URL parameter. Usage: /api/download?url=YOUR_URL'
    });
  }

  try {
    new URL(videoUrl);
  } catch (err) {
    return jsonResponse(res, 400, {
      success: false,
      error: 'Please provide a valid URL.'
    });
  }

  try {
    console.log(`Processing URL for media/slides: ${videoUrl}`);

    const output = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      extractorArgs: 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com',
      addHeader: [
        'referer:https://www.tiktok.com/',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      ]
    });

    const title = output.title || output.description || 'Downloaded Media';
    const thumbnail = output.thumbnail || (output.thumbnails && output.thumbnails[0]?.url) || '';
    const durationSec = output.duration || 0;
    const durationFormatted = formatDuration(durationSec);

    // Check for TikTok photo slideshow / multiple images
    let images = [];

    // 1. Check entries (playlist / slideshow structure in yt-dlp)
    if (output.entries && Array.isArray(output.entries)) {
      images = output.entries.map(e => e.url || e.thumbnail || (e.formats && e.formats[0]?.url)).filter(Boolean);
    }

    // 2. Check formats for image types
    if (images.length === 0 && output.formats && Array.isArray(output.formats)) {
      const imgFormats = output.formats.filter(f =>
        f.url && (f.vcodec === 'none' || f.ext === 'jpg' || f.ext === 'jpeg' || f.ext === 'png' || f.ext === 'webp') && !f.acodec
      );
      if (imgFormats.length > 1) {
        images = imgFormats.map(f => f.url);
      }
    }

    // 3. Check thumbnails if many exist (common for TikTok photo carousels)
    if (images.length === 0 && output.thumbnails && Array.isArray(output.thumbnails) && output.thumbnails.length > 1) {
      images = output.thumbnails.map(t => t.url).filter(Boolean);
    }

    // If images are found, return isImages: true with array of images
    if (images.length > 1 || (videoUrl.includes('/photo/') && images.length > 0)) {
      return jsonResponse(res, 200, {
        success: true,
        isImages: true,
        title: title,
        uploader: output.uploader || output.channel || '',
        images: images
      });
    }

    // Otherwise, return standard video/audio links
    const rawFormats = output.formats || [];
    const links = [];

    const videoFormats = rawFormats.filter(f => f.url && f.vcodec !== 'none');
    videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0));

    if (videoFormats.length > 0) {
      const hdFormat = videoFormats.find(f => (f.height || 0) >= 720) || videoFormats[0];
      links.push({
        quality: hdFormat.height ? `${hdFormat.height}p HD` : 'High Definition',
        type: 'mp4',
        url: videoUrl,
        size: formatBytes(hdFormat.filesize || hdFormat.filesize_approx)
      });

      const sdFormats = videoFormats.filter(f => (f.height || 0) <= 480 && f.height > 0);
      if (sdFormats.length > 0) {
        const sdFormat = sdFormats[0];
        links.push({
          quality: `${sdFormat.height}p SD`,
          type: 'mp4',
          url: videoUrl,
          size: formatBytes(sdFormat.filesize || sdFormat.filesize_approx)
        });
      }
    }

    const audioFormats = rawFormats.filter(f => f.url && f.vcodec === 'none' && f.acodec !== 'none');
    audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));

    if (audioFormats.length > 0) {
      const audioFormat = audioFormats[0];
      links.push({
        quality: 'Audio Only',
        type: 'mp3',
        url: videoUrl,
        size: formatBytes(audioFormat.filesize || audioFormat.filesize_approx)
      });
    }

    if (links.length === 0 && output.url) {
      links.push({
        quality: 'Standard Quality',
        type: 'mp4',
        url: videoUrl,
        size: ''
      });
    }

    return jsonResponse(res, 200, {
      success: true,
      isImages: false,
      title: title,
      duration: durationFormatted,
      thumbnail: thumbnail,
      uploader: output.uploader || output.channel || '',
      links: links
    });

  } catch (error) {
    console.error('yt-dlp error details:', error);
    const errorMsg = error.stderr || error.message || 'Failed to process URL. The post might be private, geo-blocked, or unsupported.';
    return jsonResponse(res, 500, {
      success: false,
      error: errorMsg
    });
  }
});

// Download proxy endpoint using yt-dlp to stream video/audio or proxy image downloads directly
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const filename = req.query.filename || 'video.mp4';

  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'Missing target URL' });
  }

  try {
    if (targetUrl.match(/\.(jpg|jpeg|png|webp)(\?|$)/i) || (targetUrl.includes('tiktokcdn') && !targetUrl.includes('video'))) {
      // Direct image proxy fetch
      const imgRes = await axios({
        method: 'GET',
        url: targetUrl,
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' }
      });
      res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return imgRes.data.pipe(res);
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[""]/g, '')}"`);

    const subprocess = youtubedl.exec(targetUrl, {
      output: '-',
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      format: 'best',
      addHeader: [
        'referer:https://www.tiktok.com/',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      ]
    });

    subprocess.stdout.pipe(res);

    subprocess.stderr.on('data', (data) => {
      console.error(`yt-dlp stderr: ${data.toString()}`);
    });

    subprocess.on('error', (err) => {
      console.error('yt-dlp subprocess error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Failed to stream video via yt-dlp.' });
      }
    });

    req.on('close', () => {
      if (subprocess && !subprocess.killed) {
        subprocess.kill();
      }
    });

  } catch (err) {
    console.error('Proxy streaming error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Failed to stream file from remote server.' });
    }
  }
});

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '03:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function jsonResponse(res, statusCode, data) {
  res.setHeader('Content-Type', 'application/json');
  res.status(statusCode).json(data);
}

app.listen(PORT, () => {
  console.log(`StreamSave Backend API running on port ${PORT}`);
});
