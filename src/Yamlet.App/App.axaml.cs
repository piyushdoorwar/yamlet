using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Styling;
using Yamlet.App.Services;
using Yamlet.App.Stores;
using Yamlet.App.ViewModels;
using Yamlet.App.Views;

namespace Yamlet.App;

public partial class App : Application
{
    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        // Yamlet is dark-mode only.
        RequestedThemeVariant = ThemeVariant.Dark;

        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var (viewModel, dialogService) = ComposeRoot();

            var window = new MainWindow { DataContext = viewModel };
            dialogService.Attach(window);

            // Reopen the most recently used workspace once the window is up.
            window.Opened += async (_, _) => await viewModel.InitializeAsync();

            desktop.MainWindow = window;
        }

        base.OnFrameworkInitializationCompleted();
    }

    /// <summary>
    /// Wires up the service graph by hand (no DI container needed for the MVP) and
    /// returns the root view model plus the dialog service that needs a window.
    /// </summary>
    private static (MainWindowViewModel ViewModel, DialogService Dialogs) ComposeRoot()
    {
        var yaml = new YamlSerializationService();
        var requestFiles = new RequestFileService(yaml);
        var collections = new CollectionService(yaml, requestFiles);
        var workspaces = new WorkspaceService(yaml, collections);
        var executor = RequestExecutor.CreateDefault();
        var dialogs = new DialogService();
        var recent = new RecentWorkspaceService();

        var viewModel = new MainWindowViewModel(
            workspaces, collections, requestFiles, executor, dialogs, recent);

        return (viewModel, dialogs);
    }
}
