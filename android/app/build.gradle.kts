import com.android.build.api.dsl.ManagedVirtualDevice

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.compose)
}

android {
  namespace = "app.dash"
  compileSdk = 36

  defaultConfig {
    applicationId = "app.dash"
    minSdk = 26
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures { compose = true }

  testOptions {
    unitTests.isIncludeAndroidResources = true
    managedDevices.devices {
      create<ManagedVirtualDevice>("phoneApi27") {
        device = "Pixel 2"
        apiLevel = 27
        systemImageSource = "aosp"
      }
    }
  }
}

kotlin.sourceSets.named("main") { kotlin.exclude("app/dash/ui/**") }
kotlin.sourceSets.named("main") { kotlin.exclude("app/dash/AppContainer.kt") }
kotlin.sourceSets.named("main") { kotlin.exclude("app/dash/DashApplication.kt") }
kotlin.sourceSets.named("main") { kotlin.exclude("app/dash/MainActivity.kt") }

dependencies {
  implementation(project(":core:contracts"))
  implementation(project(":core:security"))
  implementation(project(":core:network"))
  implementation(project(":core:database"))
  implementation(project(":core:auth"))
  implementation(project(":core:sync"))
  implementation(project(":core:designsystem"))
  implementation(project(":feature:account"))
  implementation(project(":feature:approval"))
  implementation(project(":feature:conversations"))
  implementation(project(":feature:chat"))
  implementation(project(":feature:agents"))
  implementation(project(":feature:settings"))
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.navigation.compose)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.process)
  implementation(libs.androidx.datastore.preferences)
  implementation(libs.kotlinx.coroutines.android)
  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.material3)
  testImplementation(project(":core:testing"))
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.robolectric)
  testImplementation(libs.turbine)
  androidTestImplementation(platform(libs.androidx.compose.bom))
  androidTestImplementation(project(":core:testing"))
  androidTestImplementation(libs.androidx.compose.ui.test.junit4)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.espresso.core)
  androidTestImplementation(libs.kotlinx.coroutines.test)
  debugImplementation(libs.androidx.compose.ui.test.manifest)
}
