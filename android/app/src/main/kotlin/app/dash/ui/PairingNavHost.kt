package app.dash.ui

import androidx.compose.runtime.Composable
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import app.dash.AppContainer
import app.dash.feature.pairing.PairingScreen
import app.dash.feature.pairing.PairingViewModel
import app.dash.feature.pairing.QrScannerScreen

@Composable
fun PairingNavHost(container: AppContainer) {
    val nav = rememberNavController()
    // One VM shared by the entry + scanner screens.
    val vm: PairingViewModel = viewModel(
        factory = viewModelFactory {
            PairingViewModel(
                saveProfile = container.profileStore::save,
                healthCheck = container::healthCheck,
            )
        },
    )
    NavHost(nav, startDestination = "pair") {
        composable("pair") {
            PairingScreen(viewModel = vm, onScanClick = { nav.navigate("scan") })
        }
        composable("scan") {
            QrScannerScreen(
                onResult = {
                    vm.submitScanned(it)
                    nav.popBackStack()
                },
                onCancel = { nav.popBackStack() },
            )
        }
    }
}
