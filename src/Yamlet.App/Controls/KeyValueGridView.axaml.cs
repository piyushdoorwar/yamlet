using Avalonia.Controls;
using Avalonia.Markup.Xaml;

namespace Yamlet.App.Controls;

/// <summary>
/// A compact editable grid for key/value/description rows, bound to an
/// <c>EditableRowsViewModel</c>. Shared by the Params, Headers and Variables tabs.
/// </summary>
public partial class KeyValueGridView : UserControl
{
    public KeyValueGridView() => AvaloniaXamlLoader.Load(this);
}
