using Avalonia.Controls;
using Avalonia.Markup.Xaml;

namespace Yamlet.App.Views;

/// <summary>Editor for a set of variables (an environment or the workspace globals).</summary>
public partial class VariableSetEditorView : UserControl
{
    public VariableSetEditorView() => AvaloniaXamlLoader.Load(this);
}
