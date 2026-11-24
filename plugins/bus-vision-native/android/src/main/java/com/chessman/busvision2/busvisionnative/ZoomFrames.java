package com.chessman.busvision2.busvisionnative;

import android.graphics.Bitmap;
import android.hardware.camera2.*;
import android.util.Base64;
import android.util.Size;
import androidx.camera.camera2.interop.Camera2Interop;
import androidx.camera.core.*;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;
import com.getcapacitor.*;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.*;

final class ZoomFrames {
    private final android.app.Activity activity;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Executor main;
    private ProcessCameraProvider provider;
    private Camera camera;
    private volatile long displayed;
    private Preview preview;
    private androidx.camera.view.PreviewView view;
    void layout(PluginCall call){
        if(view==null){call.resolve();return;}
        int parentWidth=((android.view.View)view.getParent()).getWidth();
        float scale=parentWidth/Math.max(1f,call.getFloat("viewport",1f));
        var lp=new android.widget.FrameLayout.LayoutParams(Math.round(scale*call.getFloat("width",1f)),Math.round(scale*call.getFloat("height",1f)));
        lp.leftMargin=Math.round(scale*call.getFloat("x",0f));lp.topMargin=Math.round(scale*call.getFloat("y",0f));
        view.setLayoutParams(lp);
        float extension=call.getFloat("extension",1f);
        view.setScaleX(Boolean.TRUE.equals(call.getBoolean("mirror",false))?-extension:extension);
        view.setScaleY(extension);call.resolve();
    }
    private ImageAnalysis analysis;
    private volatile JSObject latest;
    private volatile String lens = "";
    private long generation;
    ZoomFrames(android.app.Activity activity) {
        this.activity=activity; main=ContextCompat.getMainExecutor(activity);
    }
    void start(PluginCall call) {
        stop();
        long request=generation;
        var future=ProcessCameraProvider.getInstance(activity);
        future.addListener(()->{
            if(request!=generation){call.reject("camera cancelled");return;}
            try {
                provider=future.get();
                // Some devices negotiated a 2736-square analysis buffer alongside Preview.
                // Bound JPEG processing while leaving the native Preview surface unconstrained.
                var selector=new androidx.camera.core.resolutionselector.ResolutionSelector.Builder()
                    .setResolutionFilter((sizes,rotation)->{
                        var limited=new java.util.ArrayList<Size>();
                        for(Size size:sizes) if(size.getWidth()*size.getHeight()<=1920*1080)limited.add(size);
                        limited.sort((a,b)->Integer.compare(b.getWidth()*b.getHeight(),a.getWidth()*a.getHeight()));
                        return limited.isEmpty()?sizes:limited;
                    }).build();
                var builder=new ImageAnalysis.Builder().setResolutionSelector(selector)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST);
                new Camera2Interop.Extender<>(builder).setSessionCaptureCallback(new CameraCaptureSession.CaptureCallback(){
                    @Override public void onCaptureCompleted(CameraCaptureSession session,CaptureRequest req,TotalCaptureResult result){
                        if(android.os.Build.VERSION.SDK_INT>=29){
                            String id=result.get(CaptureResult.LOGICAL_MULTI_CAMERA_ACTIVE_PHYSICAL_ID);
                            if(id!=null) lens=id;
                        }
                    }
                });
                analysis=builder.build();
                analysis.setTargetRotation(activity.getWindowManager().getDefaultDisplay().getRotation());
                view=NativeCameraHost.getInstance().previewSurface();
                displayed=0;view.setFrameUpdateListener(main,timestamp->displayed++);
                preview=new Preview.Builder().build();
                preview.setSurfaceProvider(view.getSurfaceProvider());
                camera=provider.bindToLifecycle((LifecycleOwner)activity,CameraSelector.DEFAULT_BACK_CAMERA,preview,analysis);
                analysis.setAnalyzer(worker,new ImageAnalysis.Analyzer(){
                    long last;
                    @Override public void analyze(ImageProxy frame){
                        try {
                            long now=android.os.SystemClock.elapsedRealtime();
                            if(now-last<130)return;
                            last=now;
                            Bitmap bmp=frame.toBitmap();
                            ByteArrayOutputStream out=new ByteArrayOutputStream();
                            bmp.compress(Bitmap.CompressFormat.JPEG,90,out);bmp.recycle();
                            JSObject data=new JSObject();
                            data.put("jpeg",Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP));
                            data.put("rotation",frame.getImageInfo().getRotationDegrees());
                            data.put("displayed",displayed);data.put("seq",now);data.put("lens",lens);
                            latest=data;
                        } finally {frame.close();}
                    }
                });
                JSObject info=new JSObject();
                info.put("max",camera.getCameraInfo().getZoomState().getValue().getMaxZoomRatio());
                call.resolve(info);
            }catch(Exception e){stop();call.reject("camera start failed",e);}
        },main);
    }
    void zoom(float ratio,PluginCall call){
        if(camera==null){call.reject("camera closed");return;}
        var task=camera.getCameraControl().setZoomRatio(ratio);
        task.addListener(()->{try{task.get();call.resolve();}catch(Exception e){call.reject("zoom failed",e);}},main);
    }
    void frame(PluginCall call){ JSObject f=latest;call.resolve(f==null || f.optLong("seq")==call.getLong("after",-1L)?new JSObject():f); }
    void stop(){generation++;if(analysis!=null && provider!=null){analysis.clearAnalyzer();if(preview!=null)provider.unbind(preview,analysis);else provider.unbind(analysis);}preview=null;view=null;analysis=null;camera=null;latest=null;lens="";}
    void destroy(){stop();worker.shutdown();}
}
