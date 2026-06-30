package com.chessman.busvision2.busvisionnative;

import android.app.Activity;
import android.content.Context;
import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.lifecycle.LifecycleOwner;
import androidx.camera.camera2.interop.Camera2Interop;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.Preview;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.video.FallbackStrategy;
import androidx.camera.video.FileOutputOptions;
import androidx.camera.video.Quality;
import androidx.camera.video.QualitySelector;
import androidx.camera.video.Recorder;
import androidx.camera.video.Recording;
import androidx.camera.video.VideoCapture;
import androidx.camera.video.VideoRecordEvent;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

public class NativeCameraHost {
  private static final String TAG = "BusVisionCam";

  // === 新增：建立全域單例，讓 Plugin 可以直接取得這個實例，而不需要透過 MainActivity ===
  private static NativeCameraHost sharedInstance = null;

  public static NativeCameraHost getInstance() {
      return sharedInstance;
  }

  private final Activity activity;
  private final Executor mainExecutor;

  private PreviewView previewView;
  private ProcessCameraProvider cameraProvider;
  private Camera camera;
  private Preview preview;
  private VideoCapture<Recorder> videoCapture;
  private ImageCapture imageCapture;

  private Recording activeRecording;
  private final AtomicBoolean isCameraRunning = new AtomicBoolean(false);

  private volatile Integer lastIso = null;
  private volatile Long lastExposureTimeNs = null;
  private AudioWavRecorder audioRecorder;
  private volatile String lastVideoAbs = null;
  private volatile String lastAudioAbs = null;
  private volatile long recordingStartMs = 0;
  private volatile long videoFinalizeMs = 0;
  private volatile boolean isRecording = false;

  private volatile StopCallback pendingStopCallback = null;

  public interface SimpleCallback {
    void ok();
    void err(String message);
  }

  public interface CameraStartCallback {
    void onReady();
    void onError(String msg);
  }

  public NativeCameraHost(@NonNull Activity activity) {
    this.activity = activity;
    this.mainExecutor = ContextCompat.getMainExecutor(activity);
    
    // === 新增：在被 MainActivity 建立時，將自己設為全域單例 ===
    sharedInstance = this;
  }

  public void setPreviewView(PreviewView pv) {
    this.previewView = pv;
  }

  public void release() {
    stopCamera();
    previewView = null;
    if (sharedInstance == this) {
        sharedInstance = null;
    }
  }

  public void startCamera(CameraStartCallback cb) {
    if (isCameraRunning.get()) {
      Log.d(TAG, "Camera already running, calling onReady");
      if (cb != null) cb.onReady();
      return;
    }

    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
      Log.e(TAG, "Missing CAMERA permission");
      if (cb != null) cb.onError("permission_denied");
      return;
    }

    final ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(activity);
    future.addListener(() -> {
      try {
        cameraProvider = future.get();
        bindUseCases(cb);
      } catch (Exception e) {
        Log.e(TAG, "Get ProcessCameraProvider failed", e);
        if (cb != null) cb.onError("provider_fail: " + e.getMessage());
      }
    }, mainExecutor);
  }

  public void startCamera() {
    startCamera((CameraStartCallback) null);
  }

  public void stopCamera() {
    try {
      if (cameraProvider != null) {
        cameraProvider.unbindAll();
      }
      isCameraRunning.set(false);
      Log.i(TAG, "Camera stopped and unbound");
    } catch (Exception e) {
      Log.w(TAG, "stopCamera error", e);
    }
  }

  private void bindUseCases(CameraStartCallback cb) {
    if (cameraProvider == null || previewView == null) {
      Log.e(TAG, "Provider or PreviewView is null");
      if (cb != null) cb.onError("view_not_ready");
      return;
    }

    try {
      cameraProvider.unbindAll();

      CameraSelector selector = CameraSelector.DEFAULT_BACK_CAMERA;
      
      Preview.Builder previewBuilder = new Preview.Builder();
      preview = previewBuilder.build();
      preview.setSurfaceProvider(previewView.getSurfaceProvider());

      QualitySelector qualitySelector = QualitySelector.from(Quality.HD, 
          FallbackStrategy.higherQualityOrLowerThan(Quality.HD));
      
      Recorder recorder = new Recorder.Builder()
        .setQualitySelector(qualitySelector)
        .build();
      videoCapture = VideoCapture.withOutput(recorder);

      imageCapture = new ImageCapture.Builder()
        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
        .build();

      if (!(activity instanceof LifecycleOwner)) {
        if (cb != null) cb.onError("lifecycle_error");
        return;
      }

      camera = cameraProvider.bindToLifecycle((LifecycleOwner) activity, selector, preview, videoCapture, imageCapture);
      isCameraRunning.set(true);
      Log.i(TAG, "Camera successfully bound to lifecycle");
      if (cb != null) cb.onReady();
      
    } catch (Exception e) {
      Log.e(TAG, "bindUseCases error", e);
      if (cb != null) cb.onError("bind_fail: " + e.getMessage());
    }
  }

  public void startPreview(SimpleCallback cb) {
    startCamera(new CameraStartCallback() {
      @Override public void onReady() { cb.ok(); }
      @Override public void onError(String msg) { cb.err(msg); }
    });
  }

  public void stopPreview() {
    stopCamera();
  }

  public void startRecording(int sampleRate, int channels, SimpleCallback cb) {
    if (isRecording) { cb.err("already_recording"); return; }
    long ts = System.currentTimeMillis();
    File videoFile = new File(activity.getFilesDir(), "BusData/VID_" + ts + ".mp4");
    if (videoFile.getParentFile() != null) videoFile.getParentFile().mkdirs();
    File audioFile = new File(activity.getFilesDir(), "BusData/AUD_" + ts + ".wav");
    if (audioFile.getParentFile() != null) audioFile.getParentFile().mkdirs();
    
    startCamera(new CameraStartCallback() {
      @Override
      public void onReady() {
        try {
          audioRecorder = new AudioWavRecorder(new AudioWavRecorder.Config());
          audioRecorder.start(audioFile);
          
          FileOutputOptions out = new FileOutputOptions.Builder(videoFile).build();
          recordingStartMs = System.currentTimeMillis();
          lastVideoAbs = videoFile.getAbsolutePath();
          lastAudioAbs = audioFile.getAbsolutePath();
          
          activeRecording = videoCapture.getOutput()
            .prepareRecording(activity, out)
            .start(mainExecutor, event -> {
              if (event instanceof VideoRecordEvent.Finalize) {
                videoFinalizeMs = System.currentTimeMillis();
                VideoRecordEvent.Finalize finalizeEvent = (VideoRecordEvent.Finalize) event;
                
                if (pendingStopCallback != null) {
                    long dur = videoFinalizeMs - recordingStartMs;
                    boolean ok = !finalizeEvent.hasError();
                    String errStr = finalizeEvent.hasError() ? "CameraX Error: " + finalizeEvent.getError() : null;
                    
                    pendingStopCallback.onStop(ok, toDataRelative(activity, lastVideoAbs), toDataRelative(activity, lastAudioAbs), dur, lastIso, lastExposureTimeNs, errStr);
                    pendingStopCallback = null;
                }
              }
            });
            
          isRecording = true;
          cb.ok();
        } catch (Exception e) {
          Log.e(TAG, "Recording start fail", e);
          cb.err(e.getMessage()); 
        }
      }
      @Override public void onError(String msg) { cb.err(msg); }
    });
  }

  public void stopRecording(StopCallback cb) {
    this.pendingStopCallback = cb;
    isRecording = false;

    if (audioRecorder != null) { 
        try { audioRecorder.stop(); } catch (Exception ignored) {} 
    }

    if (activeRecording != null) { 
        activeRecording.stop();
        activeRecording = null; 
    } else {
        if (pendingStopCallback != null) {
            pendingStopCallback.onStop(false, null, null, 0, null, null, "Not recording");
            pendingStopCallback = null;
        }
    }
  }

  public void takePhoto(String filename, PhotoCallback cb) {
    startCamera(new CameraStartCallback() {
      @Override
      public void onReady() {
        try {
          if (imageCapture == null) {
            if (cb != null) cb.onPhoto(false, null, null, "image_capture_not_ready");
            return;
          }
          String safe = filename;
          if (safe == null || safe.trim().length() == 0) {
            safe = "IMG_" + System.currentTimeMillis() + ".jpg";
          }
          safe = safe.replaceAll("[^A-Za-z0-9._-]", "_");
          if (!safe.toLowerCase().endsWith(".jpg") && !safe.toLowerCase().endsWith(".jpeg")) {
            safe = safe + ".jpg";
          }
          final String finalSafe = safe;
          final File out = new File(activity.getFilesDir(), "BusData/" + finalSafe);
          if (out.getParentFile() != null) out.getParentFile().mkdirs();
          ImageCapture.OutputFileOptions opts = new ImageCapture.OutputFileOptions.Builder(out).build();
          imageCapture.takePicture(opts, mainExecutor, new ImageCapture.OnImageSavedCallback() {
            @Override
            public void onImageSaved(@NonNull ImageCapture.OutputFileResults outputFileResults) {
              if (cb != null) cb.onPhoto(true, out.getAbsolutePath(), finalSafe, null);
            }
            @Override
            public void onError(@NonNull ImageCaptureException exception) {
              if (cb != null) cb.onPhoto(false, null, null, exception.getMessage());
            }
          });
        } catch (Exception e) {
          if (cb != null) cb.onPhoto(false, null, null, e.getMessage());
        }
      }
      @Override public void onError(String msg) {
        if (cb != null) cb.onPhoto(false, null, null, msg);
      }
    });
  }

  public interface PhotoCallback {
    void onPhoto(boolean ok, String absPath, String filename, String err);
  }

  public static String toDataRelative(Context ctx, String absPath) {
    if (absPath == null) return null;
    String base = ctx.getFilesDir().getAbsolutePath();
    if (absPath.startsWith(base)) {
      String rel = absPath.substring(base.length());
      return rel.startsWith("/") ? rel.substring(1) : rel;
    }
    return absPath;
  }

  public static String buildDeviceString(Context ctx) {
    return Build.MANUFACTURER + " " + Build.MODEL + " (Android " + Build.VERSION.RELEASE + ")";
  }

  public interface StopCallback {
    void onStop(boolean ok, String v, String a, long d, Integer iso, Long exp, String err);
  }
}
