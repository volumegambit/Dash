plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Release identity comes from the environment so CI can sign a real bundle
// while local and debug builds stay exactly as before. See deploy/README.md.
val releaseVersionCode = (System.getenv("DASH_ANDROID_VERSION_CODE") ?: "1").toInt()
val releaseVersionName = System.getenv("DASH_ANDROID_VERSION_NAME") ?: "0.1.0"
val releaseKeystore = System.getenv("DASH_ANDROID_KEYSTORE")

android {
    namespace = "app.dash"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.dash"
        minSdk = 26
        targetSdk = 34
        versionCode = releaseVersionCode
        versionName = releaseVersionName
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("DASH_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DASH_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("DASH_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Unsigned when no keystore is configured — identical to today.
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = libs.versions.composeCompiler.get()
    }
}

dependencies {
    implementation(project(":core:model"))
    implementation(project(":core:network"))
    implementation(project(":core:connection"))
    implementation(project(":core:designsystem"))
    implementation(project(":feature:agents"))
    implementation(project(":feature:chat"))
    implementation(project(":feature:pairing"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
}
