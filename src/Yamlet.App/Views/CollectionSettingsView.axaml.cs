using Avalonia.Controls;
using Avalonia.Markup.Xaml;

namespace Yamlet.App.Views;

/// <summary>Editor for collection-level settings.</summary>
public partial class CollectionSettingsView : UserControl
{
    public CollectionSettingsView() => AvaloniaXamlLoader.Load(this);
}
