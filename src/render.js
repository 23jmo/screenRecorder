const videoElement = document.querySelector('video');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const videoSelectBtn = document.getElementById('videoSelectBtn');

let mediaRecorder;
let recordedChunks = [];
let isRecording = false;

const { Menu, desktopCapturer, dialog, shell } = require('@electron/remote');
const { writeFile } = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

// Verify ffmpeg is properly set up
try {
    ffmpeg.setFfmpegPath(ffmpegStatic);
} catch (error) {
    console.error('Failed to set up FFmpeg:', error);
    dialog.showErrorBox('Setup Error', 'Failed to initialize video converter. Recording may not work properly.');
}

// Disable stop button initially
stopBtn.disabled = true;

startBtn.onclick = async () => {
    try {
        if (!mediaRecorder) {
            dialog.showErrorBox('Error', 'Please select a screen or window to record first.');
            return;
        }

        if (isRecording) {
            console.warn('Already recording, ignoring start request');
            return;
        }

        recordedChunks = [];
        await mediaRecorder.start();
        isRecording = true;
        startBtn.classList.add('is-danger');
        startBtn.innerText = 'Recording';
        startBtn.disabled = true;
        stopBtn.disabled = false;
        videoSelectBtn.disabled = true; // Prevent source switching while recording
    } catch (error) {
        console.error('Failed to start recording:', error);
        dialog.showErrorBox('Recording Error', 'Failed to start recording. Please try again.');
        resetUI();
    }
};

stopBtn.onclick = async () => {
    try {
        if (!mediaRecorder || !isRecording) {
            console.warn('No active recording to stop');
            return;
        }

        mediaRecorder.stop();
        isRecording = false;
        resetUI();
    } catch (error) {
        console.error('Failed to stop recording:', error);
        dialog.showErrorBox('Recording Error', 'Failed to stop recording properly.');
        resetUI();
    }
};

function resetUI() {
    startBtn.classList.remove('is-danger');
    startBtn.innerText = 'Start';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    videoSelectBtn.disabled = false;
}

videoSelectBtn.onclick = getVideoSources;

async function getVideoSources() {
    try {
        // First try to get system permissions
        try {
            await navigator.mediaDevices.getUserMedia({ video: true });
        } catch (err) {
            console.log('Permission request failed:', err);
            // If permission denied, show dialog to open system preferences
            const result = await dialog.showMessageBox({
                type: 'warning',
                buttons: ['Open System Preferences', 'Cancel'],
                defaultId: 0,
                message: 'Screen Recording permission is required for this app.',
                detail: 'Please enable Screen Recording permission in System Preferences > Security & Privacy > Privacy > Screen Recording'
            });
            
            if (result.response === 0) {
                // Open system preferences to the correct page
                shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
            }
            return;
        }

        const inputSources = await desktopCapturer.getSources({
            types: ['window', 'screen']
        });

        if (inputSources.length === 0) {
            dialog.showErrorBox('Error', 'No screens or windows found to record.');
            return;
        }
        
        const videoOptionsMenu = Menu.buildFromTemplate(
            inputSources.map(source => ({
                label: source.name,
                click: () => selectSource(source)
            }))
        );

        videoOptionsMenu.popup();
    } catch (error) {
        console.error('Failed to get video sources:', error);
        dialog.showErrorBox('Error', 'Failed to get available screens and windows. Please check screen recording permissions in System Preferences.');
    }
}

async function selectSource(source) {
    try {
        videoSelectBtn.innerText = source.name;
        const constraints = {
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: source.id,
                    minWidth: 1280,
                    maxWidth: 4000,
                    minHeight: 720,
                    maxHeight: 4000
                }
            },
            optional: [{ enableLogs: false }]
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints).catch(error => {
            console.error('Media access error:', error.name);
            throw error;
        });

        videoElement.srcObject = stream;
        await videoElement.play();

        const selectedMimeType = 'video/webm; codecs=vp9';
        if (!MediaRecorder.isTypeSupported(selectedMimeType)) {
            throw new Error('Unsupported video format');
        }

        mediaRecorder = new MediaRecorder(stream, { mimeType: selectedMimeType });
        mediaRecorder.selectedMimeType = selectedMimeType;

        mediaRecorder.ondataavailable = handleDataAvailable;
        mediaRecorder.onstop = handleStop;
        mediaRecorder.onerror = (event) => {
            console.error('MediaRecorder error:', event);
            dialog.showErrorBox('Recording Error', 'An error occurred during recording.');
            resetUI();
        };

        startBtn.disabled = false;
    } catch (error) {
        console.error('Error selecting source:', error);
        dialog.showErrorBox('Error', 'Failed to set up recording source. Please try again.');
        resetUI();
    }
}

function handleDataAvailable(e) {
    if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
    }
}

async function handleStop() {
    try {
        if (recordedChunks.length === 0) {
            throw new Error('No recording data available');
        }

        const blob = new Blob(recordedChunks, {
            type: mediaRecorder.selectedMimeType
        });

        const buffer = Buffer.from(await blob.arrayBuffer());
        const tempWebmPath = `${require('os').tmpdir()}/temp-${Date.now()}.webm`;
        
        const { filePath, canceled } = await dialog.showSaveDialog({
            buttonLabel: 'Save video',
            defaultPath: `recording-${Date.now()}.mp4`,
            filters: [{ name: 'MP4 Videos', extensions: ['mp4'] }]
        });

        if (canceled || !filePath) {
            console.log('Save canceled by user');
            recordedChunks = [];
            return;
        }

        stopBtn.innerText = 'Converting Video...';

        // Save WebM file
        await new Promise((resolve, reject) => {
            writeFile(tempWebmPath, buffer, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });

        // Convert to MP4
        await new Promise((resolve, reject) => {
            ffmpeg(tempWebmPath)
                .outputOptions([
                    '-c:v libx264',
                    '-preset medium',
                    '-crf 23',
                    '-movflags +faststart'
                ])
                .toFormat('mp4')
                .on('progress', (progress) => {
                    console.log(`Processing: ${progress.percent}% done`);
                })
                .on('end', () => {
                    require('fs').unlink(tempWebmPath, () => {});
                    recordedChunks = [];
                    resolve();
                })
                .on('error', (err) => {
                    console.error('Conversion error:', err);
                    reject(err);
                })
                .save(filePath);
        }).then(() => {
            
            stopBtn.innerText = 'Stop';
            dialog.showMessageBox({
                type: 'info',
                message: 'Video saved successfully!',
                buttons: ['OK']
            });
        });

        
    } catch (error) {
        console.error('Error saving video:', error);
        dialog.showErrorBox('Error', 'Failed to save video. Please try again.');
        
        // Cleanup
        recordedChunks = [];
        if (tempWebmPath) {
            require('fs').unlink(tempWebmPath, () => {});
        }
    } finally {
        resetUI();
    }
}

// Cleanup on window close
window.addEventListener('beforeunload', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
    if (videoElement.srcObject) {
        videoElement.srcObject.getTracks().forEach(track => track.stop());
    }
});