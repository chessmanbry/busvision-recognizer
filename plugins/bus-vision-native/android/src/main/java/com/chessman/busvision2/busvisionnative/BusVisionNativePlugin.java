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

  private NativeCameraHost host;

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
