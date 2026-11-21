package com.chessman.busvision2;

import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.util.Size;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.core.content.ContextCompat;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

// Debug-only probe. No text, images or coordinates are persisted.
public class CameraProbe extends AppCompatActivity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView label = new TextView(this);
        label.setText("CameraX 取像測試中，完成後會自動關閉");
        setContentView(label);
        var executor = ContextCompat.getMainExecutor(this);
        var provider = ProcessCameraProvider.getInstance(this);
        var ocr = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        provider.addListener(() -> {
            try {
                var analysis = new ImageAnalysis.Builder().setTargetResolution(new Size(1920,1080))
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                int[] count = {0};
                analysis.setAnalyzer(executor, frame -> {
                    if (frame.getImage()==null) { frame.close(); return; }
                    long start=SystemClock.elapsedRealtime();
                    var input=InputImage.fromMediaImage(frame.getImage(),frame.getImageInfo().getRotationDegrees());
                    ocr.process(input).addOnCompleteListener(executor, task -> {
                        Log.i("BusVisionProbe","ocrMs="+(SystemClock.elapsedRealtime()-start)+" width="+frame.getWidth()+" height="+frame.getHeight()+" ok="+task.isSuccessful());
                        frame.close();
                        if (++count[0]>=12) { analysis.clearAnalyzer(); ocr.close(); finish(); }
                    });
                });
                provider.get().bindToLifecycle(this,CameraSelector.DEFAULT_BACK_CAMERA,analysis);
            } catch(Exception e) { Log.e("BusVisionProbe","probe failed",e); ocr.close(); finish(); }
        },executor);
    }
}
