import axios from 'axios';
import { program } from 'commander';

program
  .argument('<url>', 'Douyin Live URL or Room ID')
  .action(async (input) => {
    try {
      let rid = input;
      // If input is a full URL, extract the RID
      if (input.includes('douyin.com')) {
        const match = input.match(/\/(\d+)(?:\/|\?|$)/);
        if (match) {
          rid = match[1];
        } else {
          console.error('Could not extract Room ID from URL');
          return;
        }
      }

      console.log(`Processing Room ID: ${rid}`);
      await getStreamData(rid);
    } catch (error) {
      console.error('Error:', error.message);
    }
  });

program.parse();

async function getStreamData(rid) {
  const url = `https://live.douyin.com/${rid}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://live.douyin.com/',
    'Cookie': '__ac_nonce=065a4c0c100a89d7b4255' // Sometimes needed to avoid potential checks, though douyin.js doesn't explicitly send cookies in GM_xmlhttpRequest unless browser handles it.
  };

  try {
    const response = await axios.get(url, { headers });
    const html = response.data;
    const streamData = parseStreamData(html);

    if (streamData) {
      displayResults(streamData);
    } else {
      console.log('Failed to extract stream data. The room might be offline or the page structure has changed.');
    }
  } catch (error) {
    console.error('Request failed:', error.message);
  }
}

function extractJSON(pattern, pageHTML) {
  const match = pageHTML?.match(pattern);
  if (match) {
    // Mimic douyin.js cleanup: .replace(/\\/g, '').replace(/u0026/g, '&')
    // Wait, douyin.js replaces ALL backslashes? 
    // .replace(/\\/g, '') removes all backslashes.
    // .replace(/u0026/g, '&') fixes ampersands.
    return match[1].replace(/\\/g, '').replace(/u0026/g, '&');
  }
  return null;
}

function parseStreamData(pageHTML) {
  try {
    // Regex from douyin.js
    let jsonStr = extractJSON(/(\{\\"state\\":.*?)]\\n"]\)/, pageHTML);
    if (!jsonStr) {
      jsonStr = extractJSON(/(\{\\"common\\":.*?)]\\n"]\)<\/script><div hidden/, pageHTML);
    }

    if (!jsonStr) {
      // Fallback: sometimes it might be simpler or different in node fetch vs browser
      // But we stick to douyin.js logic first.
      console.error("Page JSON data not found via regex");
      return null;
    }

    const roomStoreMatch = jsonStr.match(/"roomStore":(.*?),"linkmicStore"/);
    if (!roomStoreMatch) {
      console.error("Room data not found in JSON string");
      return null;
    }

    // douyin.js logic: roomStoreMatch[1].split(',"has_commerce_goods"')[0]}}}}
    const roomStore = `${roomStoreMatch[1].split(',"has_commerce_goods"')[0]}}}}`;
    
    // Parse
    const roomData = JSON.parse(roomStore)?.roomInfo?.room;
    if (!roomData) {
      console.error("Invalid room data structure after parsing");
      return null;
    }

    const anchorNameMatch = roomStore.match(/"nickname":"(.*?)","avatar_thumb/);
    const anchorName = anchorNameMatch ? anchorNameMatch[1] : '';

    const replaceHttp = (obj) => {
        if (!obj) return null;
        return Object.entries(obj).reduce((acc, [key, value]) => {
            acc[key] = value.replace(/http:\/\//g, 'https://');
            return acc;
        }, {});
    };

    return {
      title: roomData.title,
      status: roomData.status, // 2 is live usually
      anchor_name: anchorName,
      hls_stream_url: replaceHttp(roomData?.stream_url?.hls_pull_url_map),
      flv_stream_url: replaceHttp(roomData?.stream_url?.flv_pull_url),
    };

  } catch (error) {
    console.error("Error parsing room data:", error);
    return null;
  }
}

function displayResults(data) {
  console.log('\n=== Stream Info ===');
  console.log(`Anchor: ${data.anchor_name}`);
  console.log(`Title: ${data.title}`);
  console.log(`Status: ${data.status === 2 ? 'Live' : 'Offline/Unknown'}`);
  
  const qualityMap = {
    'FULL_HD1': '原画 (Origin)',
    'HD1': '超清 (HD)',
    'SD2': '高清 (SD High)',
    'SD1': '标清 (SD)'
  };

  console.log('\n=== FLV Links ===');
  if (data.flv_stream_url) {
    for (const [key, val] of Object.entries(data.flv_stream_url)) {
      const label = qualityMap[key] || key;
      console.log(`[${label}]: ${val}`);
    }
  } else {
    console.log('None');
  }

  console.log('\n=== HLS Links ===');
  if (data.hls_stream_url) {
    for (const [key, val] of Object.entries(data.hls_stream_url)) {
        const label = qualityMap[key] || key;
        console.log(`[${label}]: ${val}`);
    }
  } else {
    console.log('None');
  }
}
