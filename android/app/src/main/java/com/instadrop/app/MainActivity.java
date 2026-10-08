package com.instadrop.app;

import android.app.*;
import android.os.*;
import android.content.*;
import android.graphics.Color;
import android.provider.MediaStore;
import android.content.ContentValues;
import android.net.Uri;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.net.*;
import java.io.*;
import java.util.concurrent.*;

public class MainActivity extends Activity {
  static final String API="https://drop-public-media.anon69f.chatgpt.site/api/resolve";
  final ExecutorService pool=Executors.newSingleThreadExecutor();
  EditText link,session;
  TextView status;
  Button download;
  String shared="";
  int background=0xff000000;
  void message(String s){runOnUiThread(()->status.setText(s));}
  int white=0xfff4f4f2, muted=0xff8c8c89, red=0xffd71920;
  int dp(float n){return (int)(getResources().getDisplayMetrics().density*n+.5f);}
  android.graphics.drawable.GradientDrawable bg(int color,int radius,int stroke){
    android.graphics.drawable.GradientDrawable d=new android.graphics.drawable.GradientDrawable();
    d.setColor(color);d.setCornerRadius(dp(radius));if(stroke!=0)d.setStroke(dp(1),stroke);return d;
  }
  TextView text(String value,int size,int color,boolean bold){
    TextView t=new TextView(this);t.setText(value);t.setTextSize(size);t.setTextColor(color);
    t.setFontFeatureSettings("kern");if(bold)t.setTypeface(android.graphics.Typeface.create("monospace",1));return t;
  }
  void add(LinearLayout parent,View child,int height,int top){
    LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,height<0?height:dp(height));p.topMargin=dp(top);parent.addView(child,p);
  }
  @Override public void onCreate(Bundle b){
    super.onCreate(b);
    getWindow().setStatusBarColor(Color.BLACK);getWindow().setNavigationBarColor(Color.BLACK);
    getWindow().getDecorView().setSystemUiVisibility(0);
    ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setBackgroundColor(Color.BLACK);
    LinearLayout root=new LinearLayout(this);root.setOrientation(1);root.setPadding(dp(20),dp(18),dp(20),dp(28));
    scroll.addView(root);setContentView(scroll);
    LinearLayout mast=new LinearLayout(this);mast.setGravity(Gravity.CENTER_VERTICAL);mast.setOrientation(0);
    TextView title=text("DROP",29,white,true);title.setLetterSpacing(.16f);mast.addView(title);
    TextView dot=text(" ●",21,red,true);mast.addView(dot);
    add(root,mast,58,0);
    TextView marker=text("PUBLIC / 01",11,muted,true);marker.setLetterSpacing(.13f);add(root,marker,22,0);
    TextView heading=text("INSTAGRAM LINK                                      01—02",11,muted,true);
    heading.setSingleLine(true);heading.setEllipsize(android.text.TextUtils.TruncateAt.END);heading.setLetterSpacing(.05f);add(root,heading,24,28);
    link=new EditText(this);link.setGravity(Gravity.TOP);link.setTextSize(16);link.setPadding(dp(18),dp(18),dp(18),dp(12));
    link.setMinLines(2);link.setHint("Paste a public post or Reel link");link.setTextColor(white);link.setHintTextColor(0xff696966);
    link.setBackground(bg(0xff111110,20,0xff333333));add(root,link,112,0);
    TextView sessionLabel=text("INSTAGRAM SESSION",11,muted,true);sessionLabel.setLetterSpacing(.1f);add(root,sessionLabel,23,26);
    session=new EditText(this);session.setSingleLine(true);session.setTextSize(14);
    session.setPadding(dp(16),0,dp(16),0);session.setHint("Instagram sessionid");session.setInputType(129);
    session.setTextColor(white);session.setHintTextColor(0xff696966);
    session.setBackground(bg(0xff111110,15,0xff292927));
    session.setText(getPreferences(0).getString("session",""));add(root,session,54,0);
    TextView note=text("Stored on this device. Required by the existing resolver.",12,muted,false);
    add(root,note,-2,10);
    download=new Button(this);download.setText("DOWNLOAD TO GALLERY");download.setTextSize(13);
    download.setAllCaps(false);download.setTypeface(android.graphics.Typeface.create("monospace",1));
    download.setTextColor(Color.BLACK);download.setBackground(bg(Color.WHITE,18,0));add(root,download,56,26);
    status=text("Works with public Instagram posts and Reels.",14,muted,false);add(root,status,-2,20);
    TextView legal=text("Save only media you own or have permission to download.",12,0xff62625f,false);
    add(root,legal,-2,40);
    download.setOnClickListener(v->start());receive(getIntent());
  }
  @Override protected void onNewIntent(Intent i){super.onNewIntent(i);setIntent(i);receive(i);}
  void receive(Intent i){
    if(Intent.ACTION_SEND.equals(i.getAction()) && "text/plain".equals(i.getType())){
      String s=i.getStringExtra(Intent.EXTRA_TEXT);
      if(s!=null){link.setText(s);if(!session.getText().toString().trim().isEmpty())start();}
    }
  }
  String canonical(String text) throws Exception {
    java.util.regex.Matcher m=java.util.regex.Pattern.compile("https?://(?:www\\.)?instagram\\.com/(?:p|reel|tv)/[A-Za-z0-9_-]+",java.util.regex.Pattern.CASE_INSENSITIVE).matcher(text);
    if(!m.find())throw new Exception("Invalid Instagram post or Reel URL");
    return m.group();
  }
  void start(){
    String url=link.getText().toString(), sid=session.getText().toString().trim();
    if(sid.isEmpty()){message("Enter your Instagram sessionid once, then download.");return;}
    getPreferences(0).edit().putString("session",sid).apply();
    download.setEnabled(false);message("Resolving media…");
    pool.execute(()->{
      try{
        JSONObject body=new JSONObject();body.put("url",canonical(url));body.put("sessionId",sid);body.put("highResolution",true);
        HttpURLConnection c=(HttpURLConnection)new URL(API).openConnection();c.setRequestMethod("POST");c.setConnectTimeout(20000);c.setReadTimeout(60000);c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");
        try(OutputStream o=c.getOutputStream()){o.write(body.toString().getBytes("UTF-8"));}
        int code=c.getResponseCode();InputStream stream=code<400?c.getInputStream():c.getErrorStream();
        ByteArrayOutputStream buffer=new ByteArrayOutputStream();byte[] tmp=new byte[8192];int n;while((n=stream.read(tmp))!=-1)buffer.write(tmp,0,n);
        JSONObject response=new JSONObject(buffer.toString("UTF-8"));c.disconnect();
        if(code>=400)throw new Exception(response.optString("error","Resolver error "+code));
        JSONArray items=response.getJSONArray("items");if(items.length()==0)throw new Exception("No downloadable media found.");
        for(int j=0;j<items.length();j++){
          JSONObject item=items.getJSONObject(j);String type=item.optString("type");boolean video=type.equals("video");
          message("Downloading "+(j+1)+" / "+items.length()+"…");
          save(item.getString("url"),video,j);
        }
        message("Saved "+items.length()+" item(s) to Pictures/Insta Drop.");
      }catch(Exception e){message("Download failed: "+e.getMessage());}
      finally{runOnUiThread(()->download.setEnabled(true));}
    });
  }
  void save(String url,boolean video,int index)throws Exception{
    HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();c.setConnectTimeout(20000);c.setReadTimeout(120000);c.setRequestProperty("User-Agent","Mozilla/5.0");if(c.getResponseCode()>=400)throw new IOException("Media HTTP "+c.getResponseCode());
    ContentValues v=new ContentValues();v.put(MediaStore.MediaColumns.DISPLAY_NAME,"DROP_"+System.currentTimeMillis()+"_"+index+(video?".mp4":".jpg"));
    v.put(MediaStore.MediaColumns.MIME_TYPE,video?"video/mp4":"image/jpeg");
    v.put(MediaStore.MediaColumns.RELATIVE_PATH,(video?"Movies":"Pictures")+"/Insta Drop");
    v.put(MediaStore.MediaColumns.IS_PENDING,1);
    Uri dest=getContentResolver().insert(video?MediaStore.Video.Media.EXTERNAL_CONTENT_URI:MediaStore.Images.Media.EXTERNAL_CONTENT_URI,v);
    if(dest==null)throw new IOException("Could not create gallery item");
    try(InputStream in=c.getInputStream();OutputStream out=getContentResolver().openOutputStream(dest)){
      byte[] bytes=new byte[32768];int n;while((n=in.read(bytes))!=-1)out.write(bytes,0,n);
      v.clear();v.put(MediaStore.MediaColumns.IS_PENDING,0);getContentResolver().update(dest,v,null,null);
    }catch(Exception e){getContentResolver().delete(dest,null,null);throw e;}finally{c.disconnect();}
  }
}
