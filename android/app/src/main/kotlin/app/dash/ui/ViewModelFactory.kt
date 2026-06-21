package app.dash.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider

/** Builds a one-off [ViewModelProvider.Factory] from a constructor lambda. */
fun <VM : ViewModel> viewModelFactory(initializer: () -> VM): ViewModelProvider.Factory =
    object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = initializer() as T
    }
