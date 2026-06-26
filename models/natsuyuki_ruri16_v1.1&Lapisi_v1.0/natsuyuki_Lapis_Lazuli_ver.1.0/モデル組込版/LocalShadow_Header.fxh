////////////////////////////////////////////////////////////////////////////////////////////////
//
//  LocalShadow_Header.fxh : LocalShadow(モデル組み込み版)
//  シャドウマップ作成に必要な基本パラメータ定義のヘッダファイルです。
//  ここのパラメータをシェーダエフェクトファイルで #include して使用します。
//
//  作成: 針金P
//
//  本エフェクト対応設定をしたモデルに対し、各モデルに応じたパラメータ最適化をここで行います。
//  ※このファイルを更新してもMMEによる自動更新は行われません。
//  ※ファイル更新後に｢MMEffect｣→｢全て更新｣で参照しているエフェクトファイルを更新する必要があります。
//  ※MMMではfull_LocalShadow_MMM.fxロード前に変更してください。変更内容が反映されない場合はMMMのCacheフォルダ内を全て削除して再トライ。
//
////////////////////////////////////////////////////////////////////////////////////////////////
// ここのパラメータを変更してください

// シャドウマップが適用させる範囲サイズ(フェイス部位より少し大きめのサイズを入力します)
#define LS_ShadowMapAreaSize  3.5

// シャドウマップが適用させる深度サイズ(モデル全体より少し大きめのサイズを入力します)
#define LS_ShadowMapDepthLength  20.0

// 影生成の計算に用いるデフォルトのライト方向(モデルが最も見栄えする方向を設定します)
#define LS_InitDirection  float3(-0.1, -0.1, 1.0)

// 影生成の計算に用いるデフォルトのぼかし強度(0～1で設定,モーフで調整可能なので,ここでは最小値を設定します)
#define LS_InitBlurPower  0.15

// 陰影が照明操作に連動するデフォルトの割合(0～1で設定,モーフで調整可能なので,ここでは最小値を設定します)
#define LS_LightSyncShade  0.5

// 遮蔽影が照明操作に連動するデフォルトの割合(0～1で設定,モーフで調整可能なので,ここでは最小値を設定します)
#define LS_LightSyncShadow  0.3

// 遮蔽影の濃度が照明操作に連動するデフォルトの割合(0～1で設定,モーフで調整可能なので,ここでは最小値を設定します)
#define LS_LightSyncDensity  0.8

// シャドウマップバッファサイズ
#define LS_ShadowMapBuffSize  512

// VSMシャドウマップの実装
#define LS_UseSoftShadow  1
// 0 : 実装しない(ソフトシャドウは使えないけど描画速度は向上する)
// 1 : 実装する(ソフトシャドウが使えるようになります)

// フェイス材質を識別するためのキー数値(材質のキー設定した反射強度を10倍した値の小数部を入力します)
#define LS_ExecKey  0.39


// 解らない人はここから下はいじらないでね

////////////////////////////////////////////////////////////////////////////////////////////////
// パラメータ定義

// コントロールパラメータ
float3   LocalShadow_BonePos     : CONTROLOBJECT < string name = "(self)"; string item = "LS_Center"; >;
float4x4 LocalShadow_BoneMatrix  : CONTROLOBJECT < string name = "(self)"; string item = "LS_Center"; >;
float    LocalShadow_MorphLtSync : CONTROLOBJECT < string name = "(self)"; string item = "LS_LtSync"; >;

// クォータニオンの積算
float4 LocalShadow_MulQuat(float4 q1, float4 q2)
{
   return float4(cross(q1.xyz, q2.xyz)+q1.xyz*q2.w+q2.xyz*q1.w, q1.w*q2.w-dot(q1.xyz, q2.xyz));
}

// クォータニオンの回転
float3 LocalShadow_RotQuat(float3 v1, float3 v2, float3 pos)
{
   float3 s = cross(v2, v1);
   if( !any(s) ) s = float3(1,0,0);
   float3 v = normalize( s );
   float rot = acos( dot(v1, v2) );
   float sinHD = sin(0.5f * rot);
   float cosHD = cos(0.5f * rot);
   float4 q1 = float4(v*sinHD, cosHD);
   float4 q2 = float4(-v*sinHD, cosHD);
   float4 q = LocalShadow_MulQuat( LocalShadow_MulQuat(q2, float4(pos, 0.0f)), q1);

   return q.xyz;
}

// ライト方向(エフェクト設定方向)
float3 LocalShadow_LtDirection : DIRECTION < string Object = "Light"; >;
static float3 LocalShadow_LtCtrlDir = LocalShadow_RotQuat(float3(0,0.0001,1), normalize(LocalShadow_BoneMatrix._31_32_33), normalize(LS_InitDirection));
static float  LocalShadow_MorphLtSync1 = lerp(LS_LightSyncShade, 1.0f, LocalShadow_MorphLtSync);
static float  LocalShadow_MorphLtSync2 = lerp(LS_LightSyncShadow, 1.0f, LocalShadow_MorphLtSync);
static float3 LocalShadow_LightDirection = normalize(lerp(LocalShadow_LtCtrlDir, LocalShadow_LtDirection, LocalShadow_MorphLtSync2));


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// 座標変換行列

// ライト方向のビュー変換行列
float4x4 LocalShadow_LightViewMatrix()
{
   // z軸方向ベクトル
   float3 viewZ = LocalShadow_LightDirection;

   // x軸方向ベクトル
   float3 viewX = cross( LocalShadow_BoneMatrix._21_22_23, LocalShadow_LightDirection ); 

   // x軸方向ベクトルの正規化(LookDirとLookUpDirの方向が一致する場合は特異値となる)
   if( !any(viewX) ) viewX = LocalShadow_BoneMatrix._11_21_31;
   viewX = normalize(viewX);

   // y軸方向ベクトル
   float3 viewY = cross( viewZ, viewX );  // 共に垂直なのでこれで正規化

   // ビュー座標変換の回転行列
   float3x3 ltViewRot = float3x3( viewX.x, viewY.x, viewZ.x,
                                  viewX.y, viewY.y, viewZ.y,
                                  viewX.z, viewY.z, viewZ.z );

   // 仮の光源位置
   float3 ltViewPos = LocalShadow_BonePos - LocalShadow_LightDirection * LS_ShadowMapDepthLength;

   // ビュー変換行列
   return float4x4( ltViewRot[0],  0,
                    ltViewRot[1],  0,
                    ltViewRot[2],  0,
                   -mul( ltViewPos, ltViewRot ), 1 );
}


// ライト方向の射影変換行列
float4x4 LocalShadow_LightProjMatrix()
{
   float s = 2.0f / LS_ShadowMapAreaSize;
   float d = 0.5f / LS_ShadowMapDepthLength;

   return float4x4( s, 0, 0, 0,
                    0, s, 0, 0,
                    0, 0, d, 0,
                    0, 0, 0, 1 );
}


float4x4 LocalShadow_WorldMatrix : WORLD;

static float4x4 LocalShadow_LightViewProjMatrix = mul( LocalShadow_LightViewMatrix(), LocalShadow_LightProjMatrix() );
static float4x4 LocalShadow_LightWorldViewProjMatrix = mul( LocalShadow_WorldMatrix, LocalShadow_LightViewProjMatrix );


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

#ifndef LOCALSHADOWMAPDRAW

// フェイス材質判定
float LocalShadow_SpecularPower : SPECULARPOWER < string Object = "Geometry"; >;
static bool LocalShadow_Valid = (abs(frac(LocalShadow_SpecularPower*10.0f) - LS_ExecKey) < 0.001f);

// ライト方向の修正
float3 LocalShadow_GetLightDirection(float3 ltDir)
{
    if( LocalShadow_Valid ){
        ltDir = normalize( lerp(LocalShadow_LtCtrlDir, ltDir, LocalShadow_MorphLtSync1) );
    }
    return ltDir;
}


////////////////////////////////////////////////////////////////////////////////////////////////
// シャドウマップ関連の処理

// シャドウマップバッファサイズ
#define SMAPSIZE_WIDTH   LS_ShadowMapBuffSize
#define SMAPSIZE_HEIGHT  LS_ShadowMapBuffSize

#if LS_UseSoftShadow==1
    #define TEX_FORMAT  "D3DFMT_G32R32F"
    #define TEX_MIPLEVELS  0
#else
    #define TEX_FORMAT  "D3DFMT_R32F"
    #define TEX_MIPLEVELS  1
#endif

// オフスクリーンシャドウマップバッファ
texture LS_ShadowMap : OFFSCREENRENDERTARGET <
    string Description = "LocalShadow(モデル組み込み版)のシャドウマップ";
    int Width  = SMAPSIZE_WIDTH;
    int Height = SMAPSIZE_HEIGHT;
    float4 ClearColor = { 1, 1, 1, 1 };
    float ClearDepth = 1.0;
    string Format = TEX_FORMAT;
    bool AntiAlias = false;
    int Miplevels = TEX_MIPLEVELS;
    string DefaultEffect = 
        "self = LocalShadow_ShadowMap.fxsub;"
        "* = hide;";
>;
sampler LocalShadow_ShadowMapSamp = sampler_state {
    texture = <LS_ShadowMap>;
    MinFilter = LINEAR;
    MagFilter = LINEAR;
    MipFilter = LINEAR;
    AddressU  = CLAMP;
    AddressV = CLAMP;
};


// 影濃度
float LocalShadow_MorphSdDens1 : CONTROLOBJECT < string name = "(self)"; string item = "LS_Dens-"; >;
float LocalShadow_MorphSdDens2 : CONTROLOBJECT < string name = "(self)"; string item = "LS_Dens+"; >;
static float LocalShadow_MorphLtSync3 = lerp(LS_LightSyncDensity, 1.0f, LocalShadow_MorphLtSync);
static float LocalShadow_LtCtrlDens = smoothstep(-1.5f+1.5f*LocalShadow_MorphLtSync3, LocalShadow_MorphLtSync3, dot(LocalShadow_LightDirection, LocalShadow_LtDirection));
static float LocalShadow_Density1 = (1.0f - LocalShadow_MorphSdDens1) * LocalShadow_LtCtrlDens;
static float LocalShadow_Density2 = 1.0f + 5.0f * LocalShadow_MorphSdDens2;


#if LS_UseSoftShadow==1
// VSMシャドウマップ関連の処理

    // ぼかし強度
    float LocalShadow_MorphSdBulr : CONTROLOBJECT < string name = "(self)"; string item = "LS_Blur"; >;
    static float LocalShadow_ShadowBulrPower = lerp(LS_InitBlurPower, 1.0f, LocalShadow_MorphSdBulr) * 5.0f;

    // シャドウマップの周辺サンプリング回数
    #define BASESMAP_COUNT  4

    // シャドウマップバッファサイズ
    #define SMAPSIZE_WIDTH   LS_ShadowMapBuffSize
    #define SMAPSIZE_HEIGHT  LS_ShadowMapBuffSize

    // シャドウマップのサンプリング間隔
    static float2 LocalShadow_SMapSampStep = float2(LocalShadow_ShadowBulrPower/SMAPSIZE_WIDTH, LocalShadow_ShadowBulrPower/SMAPSIZE_HEIGHT);

    // シャドウマップの周辺サンプリング1
    float2 LocalShadow_GetZPlotSampleBase1(float2 Tex, float smpScale)
    {
        float2 smpStep = LocalShadow_SMapSampStep * smpScale;
        float mipLv = log2( max(SMAPSIZE_WIDTH*smpStep.x, 1.0f) );
        float2 zplot = tex2Dlod(LocalShadow_ShadowMapSamp, float4(Tex, 0, mipLv)).xy * 2.0f;
        zplot += tex2Dlod(LocalShadow_ShadowMapSamp, float4(Tex+smpStep*float2(-1,-1), 0, mipLv)).xy;
        zplot += tex2Dlod(LocalShadow_ShadowMapSamp, float4(Tex+smpStep*float2( 1,-1), 0, mipLv)).xy;
        zplot += tex2Dlod(LocalShadow_ShadowMapSamp, float4(Tex+smpStep*float2(-1, 1), 0, mipLv)).xy;
        zplot += tex2Dlod(LocalShadow_ShadowMapSamp, float4(Tex+smpStep*float2( 1, 1), 0, mipLv)).xy;
        return (zplot / 6.0f);
    }

    // シャドウマップの周辺サンプリング2
    float2 LocalShadow_GetZPlotSampleBase2(float2 Tex, float smpScale)
    {
        float2 smpStep = LocalShadow_SMapSampStep * smpScale;
        float mipLv = log2( max(SMAPSIZE_WIDTH*smpStep.x, 1.0f) );
        float2 zplot = tex2Dlod(LocalShadow_ShadowMapSamp, float4(Tex, 0, mipLv)).xy * 2.0f;
        zplot += tex2Dlod(LocalShadow_ShadowMapSamp, float4(Tex+smpStep*float2(-1, 0), 0, mipLv)).xy;
        zplot += tex2Dlod(LocalShadow_ShadowMapSamp, float4(Tex+smpStep*float2( 1, 0), 0, mipLv)).xy;
        zplot += tex2Dlod(LocalShadow_ShadowMapSamp, float4(Tex+smpStep*float2( 0,-1), 0, mipLv)).xy;
        zplot += tex2Dlod(LocalShadow_ShadowMapSamp, float4(Tex+smpStep*float2( 0, 1), 0, mipLv)).xy;
        return (zplot / 6.0f);
    }

    // セルフシャドウの遮蔽確率を求める
    float LocalShadow_GetSelfShadowRate(float2 SMapTex, float z)
    {
        // シャドウマップよりZプロットの統計処理(zplot.x:平均, zplot.y:2乗平均)
        float2 zplot = float2(0,0);
        float rate = 1.0f;
        float sumRate = 0.0f;
        [unroll]
        for(int i=0; i<BASESMAP_COUNT; i+=2) {
            rate *= 0.5f; sumRate += rate;
            zplot += LocalShadow_GetZPlotSampleBase1(SMapTex, float(i+1)) * rate;
            rate *= 0.5f; sumRate += rate;
            zplot += LocalShadow_GetZPlotSampleBase2(SMapTex, float(i+2)) * rate;
        }
        zplot /= sumRate;

        // 影部判定(VSM:Variance Shadow Maps法)
        float variance = max( zplot.y - zplot.x * zplot.x, 0.05f/LS_ShadowMapDepthLength );
        float comp = variance / (variance + max(z - zplot.x, 0.0f));

        comp = smoothstep(0.1f/max(LocalShadow_ShadowBulrPower, 1.0f), 1.0f, comp);
        return (1.0f-(1.0f-comp)*LocalShadow_Density1);
    }

#else
// ソフトシャドウを使わない場合

    #define LocalShadow_SKII1  (200.0f*LS_ShadowMapDepthLength)

    // セルフシャドウの遮蔽確率を求める
    float LocalShadow_GetSelfShadowRate(float2 SMapTex, float z)
    {
        float comp;
        float dist = max( z - tex2D(LocalShadow_ShadowMapSamp, SMapTex).r, 0.0f );
        comp = 1.0f - saturate( dist * LocalShadow_SKII1 - 7.0f);

        return (1.0f-(1.0f-comp)*LocalShadow_Density1);
    }

#endif


////////////////////////////////////////////////////////////////////////////////////////////////
// 濃度設定関連の処理

struct  LocalShadow_COLOR {
    float4 Color;        // オブジェクト色
    float4 ShadowColor;  // 影色
};

// 影色に濃度を加味する
LocalShadow_COLOR LocalShadow_GetShadowDensity(float4 Color, float4 ShadowColor, bool useToon, float LightNormal)
{
    LocalShadow_COLOR Out;
    Out.Color = Color;

    float e = max(LocalShadow_Density2, 1.0f);
    float a = 1.0f / e;
    float b = 1.0f - smoothstep(3.0f, 6.0f, e);
    float3 color = lerp(ShadowColor.rgb*a, ShadowColor.rgb*b, pow(ShadowColor.rgb, e));
    Out.ShadowColor = float4(saturate(color), ShadowColor.a);

    return Out;
}


#endif
