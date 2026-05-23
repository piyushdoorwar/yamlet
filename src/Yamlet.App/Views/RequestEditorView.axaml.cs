using Avalonia.Controls;
using Avalonia.Markup.Xaml;

namespace Yamlet.App.Views;

/// <summary>Editor for a single request, including the response panel.</summary>
public partial class RequestEditorView : UserControl
{
    public RequestEditorView() => AvaloniaXamlLoader.Load(this);
}
