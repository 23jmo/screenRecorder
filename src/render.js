const videoElement = document.querySelector('video');
const startBtn = document.getElementById('startBtn');
startBtn.onclick = () => {
    recordedChunks = [];
    mediaRecorder.start();
    mediaRecorder.state = 'recording';
    startBtn.classList.add('is-danger');
    startBtn.innerText = 'Recording';
}

const stopBtn = document.getElementById('stopBtn');
stopBtn.onclick = () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        startBtn.classList.remove('is-danger');
        startBtn.innerText = 'Start';
    }
}

const videoSelectBtn = document.getElementById('videoSelectBtn');

videoSelectBtn.onclick = getVideoSources;

let mediaRecorder;
let recordedChunks = [];

const { Menu, desktopCapturer, dialog } = require('@electron/remote');
const { writeFile } = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegStatic);


async function getVideoSources() {
    console.log("getVideoSources");
    try {
        const inputSources = await desktopCapturer.getSources({
            types: ['window', 'screen']
        });
        
        const videoOptionsMenu = Menu.buildFromTemplate(
            inputSources.map(source => {
                return {
                    label: source.name,
                    click: () => selectSource(source)
                };
            })
        );

        videoOptionsMenu.popup();
    } catch (error) {
        console.error('Error:', error);
    }
}

async function selectSource(source) {
    videoSelectBtn.innerText = source.name;
    const constraints = {
        audio: false,
        video: {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: source.id
            }
        }
    };

    // Create a Stream
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // Preview the source in a video element
    videoElement.srcObject = stream;
    videoElement.play();

    let options;
    // Always use WebM for more reliable support
    const selectedMimeType = 'video/webm; codecs=vp9';
    options = { mimeType: selectedMimeType };
    
    mediaRecorder = new MediaRecorder(stream, options);
    mediaRecorder.selectedMimeType = selectedMimeType;

    //Register Event Handlers

    mediaRecorder.ondataavailable = handleDataAvailable;
    mediaRecorder.onstop = handleStop;

}

function handleDataAvailable(e) {
    console.log('video data available');
    recordedChunks.push(e.data);
}

async function handleStop() {
    console.log('recording stopped');
    const blob = new Blob(recordedChunks, {
        type: mediaRecorder.selectedMimeType
    });

    const buffer = Buffer.from(await blob.arrayBuffer());

    // First save as WebM
    const tempWebmPath = `${require('os').tmpdir()}/temp-${Date.now()}.webm`;
    
    const { filePath } = await dialog.showSaveDialog({
        buttonLabel: 'Save video',
        defaultPath: `vid-${Date.now()}.mp4`,
        filters: [
            { name: 'MP4 Videos', extensions: ['mp4'] }
        ]
    });

    if (!filePath) {
        recordedChunks = [];
        return;
    }

    // Write the WebM file first
    await new Promise((resolve, reject) => {
        writeFile(tempWebmPath, buffer, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });

    // Convert WebM to MP4 with basic settings
    await new Promise((resolve, reject) => {
        ffmpeg(tempWebmPath)
            .outputOptions([
                '-c:v libx264',     // Use H.264 codec
                '-preset medium',    // Balance between speed/compression
                '-crf 23',          // Constant Rate Factor (quality)
                '-movflags +faststart'  // Web playback optimization
            ])
            .toFormat('mp4')
            .on('start', (commandLine) => {
                console.log('FFmpeg conversion started:', commandLine);
            })
            .on('progress', (progress) => {
                console.log('Processing: ', progress.percent, '% done');
            })
            .on('end', () => {
                console.log('Conversion finished');
                // Delete the temporary WebM file
                require('fs').unlink(tempWebmPath, (err) => {
                    if (err) console.error('Error deleting temp file:', err);
                });
                recordedChunks = [];
                resolve();
            })
            .on('error', (err) => {
                console.error('Error during conversion:', err);
                reject(err);
            })
            .save(filePath);
    });

    console.log('Video saved successfully!');
}