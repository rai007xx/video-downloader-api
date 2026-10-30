const express = require('express');
const cors = require('cors');
const youtubedl = require('yt-dlp-exec');
const https = require('https');
const http = require('http');

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
    version: '1.0.1',
    endpoints: {
      download: 'GET /api/download?url=YOUR_VIDEO_URL',
      proxy: 'GET /api/proxy?url=DIRECT_MEDIA_URL&filename=video.mp4'
    }
  });
});

// Video metadata & direct links endpoint
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
      error: 'Please provide a valid video URL.'
    });
  }

  try {
    console.log(`Processing video URL: ${videoUrl}`);

    const output = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0']
    });

    const title = output.title || 'Downloaded Video';
    const thumbnail = output.thumbnail || (output.thumbnails && output.thumbnails[0]?.url) || '';
    const durationSec = output.duration || 0;
    const durationFormatted = formatDuration(durationSec);

    const rawFormats = output.formats || [];
    const links = [];

    const videoFormats = rawFormats.filter(f => f.url && f.vcodec !== 'none');
    videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0));

    if (videoFormats.length > 0) {
      const hdFormat = videoFormats.find(f => (f.height || 0) >= 720) || videoFormats[0];
      links.push({
        quality: hdFormat.height ? `${hdFormat.height}p HD` : 'High Definition',
        type: 'mp4',
        url: hdFormat.url,
        size: formatBytes(hdFormat.filesize || hdFormat.filesize_approx)
      });

      const sdFormats = videoFormats.filter(f => (f.height || 0) <= 480 && f.height > 0);
      if (sdFormats.length > 0) {
        const sdFormat = sdFormats[0];
        links.push({
          quality: `${sdFormat.height}p SD`,
          type: 'mp4',
          url: sdFormat.url,
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
        url: audioFormat.url,
        size: formatBytes(audioFormat.filesize || audioFormat.filesize_approx)
      });
    }

    if (links.length === 0 && output.url) {
      links.push({
        quality: 'Standard Quality',
        type: 'mp4',
        url: output.url,
        size: ''
      });
    }

    return jsonResponse(res, 200, {
      success: true,
      title: title,
      duration: durationFormatted,
      thumbnail: thumbnail,
      uploader: output.uploader || output.channel || '',
      links: links
    });

  } catch (error) {
    console.error('yt-dlp error:', error.message);
    return jsonResponse(res, 500, {
      success: false,
      error: 'Failed to process video. The URL might be private, geo-blocked, or unsupported.'
    });
  }
});

// Download proxy endpoint to force file download without CORS new-tab opening
app.get('/api/proxy', (req, res) => {
  const targetUrl = req.query.url;
  const filename = req.query.filename || 'video.mp4';

  if (!targetUrl) {
    return res.status(400).send('Missing target URL');
  }

  const client = targetUrl.startsWith('https') ? https : http;

  client.get(targetUrl, (externalRes) => {
    // If redirected, follow redirect
    if (externalRes.statusCode >= 300 && externalRes.statusCode < 400 && externalRes.headers.location) {
      return res.redirect(`/api/proxy?url=${encodeURIComponent(externalRes.headers.location)}&filename=${encodeURIComponent(filename)}`);
    }

    res.setHeader('Content-Type', externalRes.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[""]/g, '')}"`);
    if (externalRes.headers['content-length']) {
      res.setHeader('Content-Length', externalRes.headers['content-length']);
    }

    externalRes.pipe(res);
  }).on('error', (err) => {
    console.error('Proxy error:', err);
    res.status(500).send('Failed to download file stream.');
  });
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
