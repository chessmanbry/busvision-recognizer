package com.chessman.busvision2.busvisionnative;

import android.Manifest;
import android.content.pm.PackageManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "BusVisionNative",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class BusVisionNativePlugin extends Plugin {

  private ZoomFrames frames;
  @PluginMethod public void startZoomCamera(PluginCall call){
    if(getPermissionState("camera")!=PermissionState.GRANTED){requestPermissionForAlias("camera",call,"zoomPermission");return;}
    openZoom(call);
  }
  @PermissionCallback private void zoomPermission(PluginCall call){
    if(getPermissionState("camera")==PermissionState.GRANTED)openZoom(call);else call.reject("camera permission denied");
  }
  private void openZoom(PluginCall call){getActivity().runOnUiThread(()->{
    if(frames==null)frames=new ZoomFrames(getActivity());frames.start(call);
  });}
  @PluginMethod public void layoutZoomPreview(PluginCall call){getActivity().runOnUiThread(()->{if(frames!=null)frames.layout(call);else call.resolve();});}
  @PluginMethod public void zoomFrame(PluginCall call){if(frames==null)call.resolve(new JSObject());else frames.frame(call);}
  @PluginMethod public void setCameraRatio(PluginCall call){getActivity().runOnUiThread(()->{
    if(frames==null)call.reject("camera closed");else frames.zoom(call.getFloat("ratio",1f),call);
  });}
  @PluginMethod public void stopZoomCamera(PluginCall call){getActivity().runOnUiThread(()->{if(frames!=null)frames.stop();call.resolve();});}
  @Override protected void handleOnPause(){super.handleOnPause();getActivity().runOnUiThread(()->{if(frames!=null)frames.stop();});}
  private NativeCameraHost host;
  private final java.util.concurrent.atomic.AtomicBoolean ocrBusy = new java.util.concurrent.atomic.AtomicBoolean(false);
  private com.google.mlkit.vision.text.TextRecognizer textRecognizer;

  @PluginMethod
  public void recognizeText(PluginCall call) {
    String data = call.getString("image");
    if (data == null || data.length() > 16000000) { call.reject("Invalid OCR image"); return; }
    if (!ocrBusy.compareAndSet(false, true)) { call.reject("OCR_BUSY"); return; }
    final long started = android.os.SystemClock.elapsedRealtime();
    android.graphics.Bitmap bitmap;
    try {
      int comma = data.indexOf(',');
      byte[] bytes = android.util.Base64.decode(comma >= 0 ? data.substring(comma + 1) : data, android.util.Base64.DEFAULT);
      android.graphics.BitmapFactory.Options bounds = new android.graphics.BitmapFactory.Options();
      bounds.inJustDecodeBounds = true;
      android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
      if (bounds.outWidth < 1 || bounds.outHeight < 1 || (long)bounds.outWidth * bounds.outHeight > 25000000L) throw new IllegalArgumentException("Invalid image dimensions");
      android.graphics.BitmapFactory.Options options = new android.graphics.BitmapFactory.Options();
      while (Math.max(bounds.outWidth, bounds.outHeight) / Math.max(1, options.inSampleSize) > 2200) options.inSampleSize = Math.max(1, options.inSampleSize) * 2;
      bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
      if (bitmap == null) throw new IllegalArgumentException("Cannot decode image");
      if (textRecognizer == null) textRecognizer = com.google.mlkit.vision.text.TextRecognition.getClient(new com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions.Builder().build());
    } catch (Exception error) { ocrBusy.set(false); call.reject("OCR image preparation failed", error); return; }
    final android.graphics.Bitmap input = bitmap;
    textRecognizer.process(com.google.mlkit.vision.common.InputImage.fromBitmap(input, 0))
      .addOnSuccessListener(result -> {
        com.getcapacitor.JSArray lines = new com.getcapacitor.JSArray();
        for (com.google.mlkit.vision.text.Text.TextBlock block : result.getTextBlocks()) {
          for (com.google.mlkit.vision.text.Text.Line line : block.getLines()) {
            android.graphics.Rect box = line.getBoundingBox();
            if (box == null) continue;
            JSObject row = new JSObject(); row.put("text", line.getText()); row.put("confidence", line.getConfidence());
            row.put("x", box.left); row.put("y", box.top); row.put("w", box.width()); row.put("h", box.height()); lines.put(row);
          }
        }
        JSObject output = new JSObject(); output.put("lines", lines); output.put("width", input.getWidth()); output.put("height", input.getHeight());
        output.put("engine", "mlkit-chinese"); output.put("elapsedMs", android.os.SystemClock.elapsedRealtime() - started); call.resolve(output);
      })
      .addOnFailureListener(error -> call.reject("Native OCR failed", error))
      .addOnCompleteListener(task -> { input.recycle(); ocrBusy.set(false); });
  }

  @Override
  protected void handleOnDestroy() {
    if (textRecognizer != null) { textRecognizer.close(); textRecognizer = null; }
    getActivity().runOnUiThread(()->{if(frames!=null)frames.destroy();});
    super.handleOnDestroy();
  }


  @Override
  public void load() {
    super.load();
    // === 修改：直接從全域單例取得已經綁定好畫面的 NativeCameraHost ===
    // 移除對 MainActivity 的依賴，解決模組間互相 import 導致編譯失敗的問題
    host = NativeCameraHost.getInstance();
    
    if (host == null) {
        Log.w("BusVisionNative", "NativeCameraHost is null on Plugin load. Falling back to new instance.");
        host = new NativeCameraHost(getActivity());
    }
  }

  @PluginMethod
  public void isNativeAvailable(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("available", true);
    call.resolve(ret);
  }

  @PluginMethod
  public void ensurePermissions(PluginCall call) {
    if (getPermissionState("camera") != PermissionState.GRANTED ||
        getPermissionState("microphone") != PermissionState.GRANTED) {
      requestAllPermissions(call, "completePermissionRequest");
    } else {
      JSObject ret = new JSObject();
      ret.put("camera", "granted");
      ret.put("microphone", "granted");
      call.resolve(ret);
    }
  }

  @PermissionCallback
  private void completePermissionRequest(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("camera", getPermissionState("camera"));
    ret.put("microphone", getPermissionState("microphone"));
    call.resolve(ret);
  }

  @PluginMethod
  public void startCamera(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      try {
        host.startPreview(new NativeCameraHost.SimpleCallback() {
          @Override
          public void ok() {
            call.resolve();
          }

          @Override
          public void err(String msg) {
            call.reject(msg);
          }
        });
      } catch (Exception e) {
        call.reject("startCamera error: " + e.getMessage(), e);
      }
    });
  }

  @PluginMethod
  public void stopCamera(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      try {
        host.stopPreview();
        call.resolve();
      } catch (Exception e) {
        call.reject("stopCamera error: " + e.getMessage(), e);
      }
    });
  }

  @PluginMethod
  public void takePhoto(PluginCall call) {
    String filename = call.getString("filename", "IMG_" + System.currentTimeMillis() + ".jpg");
    host.takePhoto(filename, new NativeCameraHost.PhotoCallback() {
      @Override
      public void onPhoto(boolean ok, String absPath, String savedName, String err) {
        if (!ok) {
          call.reject(err != null ? err : "takePhoto failed");
          return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("path", NativeCameraHost.toDataRelative(getContext(), absPath));
        ret.put("filename", savedName);
        ret.put("mimeType", "image/jpeg");
        call.resolve(ret);
      }
    });
  }

  @PluginMethod
  public void startRecording(PluginCall call) {
    int sampleRate = call.getInt("sampleRate", 48000);
    int channels = call.getInt("channels", 1);

    host.startRecording(sampleRate, channels, new NativeCameraHost.SimpleCallback() {
      @Override
      public void ok() {
        call.resolve();
      }

      @Override
      public void err(String msg) {
        call.reject(msg);
      }
    });
  }

  @PluginMethod
  public void stopRecording(PluginCall call) {
    host.stopRecording(new NativeCameraHost.StopCallback() {
      @Override
      public void onStop(boolean ok, String videoAbs, String audioAbs, long durationMs, Integer iso, Long exposureTimeNs, String err) {
        if (!ok) {
          call.reject(err != null ? err : "stopRecording failed");
          return;
        }
        JSObject ret = new JSObject();
        if (videoAbs != null) ret.put("path", NativeCameraHost.toDataRelative(getContext(), videoAbs));
        if (audioAbs != null) ret.put("audioPath", NativeCameraHost.toDataRelative(getContext(), audioAbs));
        ret.put("durationMs", durationMs);
        JSObject camMeta = new JSObject();
        if (iso != null) camMeta.put("iso", iso);
        if (exposureTimeNs != null) camMeta.put("exposureTimeNs", exposureTimeNs);
        camMeta.put("device", NativeCameraHost.buildDeviceString(getContext()));
        ret.put("cameraMeta", camMeta);
        call.resolve(ret);
      }
    });
  }
}
